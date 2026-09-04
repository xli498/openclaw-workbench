param(
  [Parameter(Mandatory = $true)]
  [string]$Payload
)

$ErrorActionPreference = 'Stop'

try {
  $inputObject = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($Payload)) | ConvertFrom-Json

  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class OcwWindowsAnchor
{
    const uint GenericRead = 0x80000000;
    const uint ShareRead = 0x00000001;
    const uint ShareWrite = 0x00000002;
    const uint OpenExisting = 3;
    const uint FileFlagBackupSemantics = 0x02000000;
    const uint FileFlagOpenReparsePoint = 0x00200000;
    const uint FileAttributeDirectory = 0x00000010;
    const uint FileAttributeReparsePoint = 0x00000400;

    [StructLayout(LayoutKind.Sequential)]
    struct ByHandleFileInformation
    {
        public uint FileAttributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
        public uint VolumeSerialNumber;
        public uint FileSizeHigh;
        public uint FileSizeLow;
        public uint NumberOfLinks;
        public uint FileIndexHigh;
        public uint FileIndexLow;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern SafeFileHandle CreateFile(
        string fileName, uint desiredAccess, uint shareMode, IntPtr securityAttributes,
        uint creationDisposition, uint flagsAndAttributes, IntPtr templateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetFileInformationByHandle(SafeFileHandle handle, out ByHandleFileInformation information);

    [StructLayout(LayoutKind.Sequential)]
    struct JobObjectBasicLimitInformation
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JobObjectExtendedLimitInformation
    {
        public JobObjectBasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JobObjectExtendedLimitInformation info, uint length);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateJobObject(IntPtr job, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr handle);

    static SafeFileHandle LockDirectory(string directory)
    {
        SafeFileHandle handle = CreateFile(
            directory,
            GenericRead,
            ShareRead | ShareWrite,
            IntPtr.Zero,
            OpenExisting,
            FileFlagBackupSemantics | FileFlagOpenReparsePoint,
            IntPtr.Zero);
        if (handle.IsInvalid) throw new IOException("directory lock failed");
        ByHandleFileInformation information;
        if (!GetFileInformationByHandle(handle, out information)) {
            handle.Dispose();
            throw new IOException("directory inspection failed");
        }
        if ((information.FileAttributes & FileAttributeDirectory) == 0 || (information.FileAttributes & FileAttributeReparsePoint) != 0) {
            handle.Dispose();
            throw new IOException("directory is not a regular directory");
        }
        return handle;
    }

    static string QuoteArgument(string value)
    {
        if (String.IsNullOrEmpty(value)) return "\"\"";
        bool needsQuotes = false;
        foreach (char character in value) if (Char.IsWhiteSpace(character) || character == '"') { needsQuotes = true; break; }
        if (!needsQuotes) return value;
        var output = new System.Text.StringBuilder();
        output.Append('"');
        int slashes = 0;
        foreach (char character in value) {
            if (character == '\\') { slashes++; continue; }
            if (character == '"') {
                output.Append('\\', slashes * 2 + 1);
                output.Append('"');
                slashes = 0;
                continue;
            }
            output.Append('\\', slashes);
            slashes = 0;
            output.Append(character);
        }
        output.Append('\\', slashes * 2);
        output.Append('"');
        return output.ToString();
    }

    static bool IsDescendant(string root, string candidate)
    {
        return String.Equals(root, candidate, StringComparison.OrdinalIgnoreCase)
            || candidate.StartsWith(root.EndsWith(Path.DirectorySeparatorChar.ToString()) ? root : root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
    }

    static void KillTree(int processId)
    {
        try {
            var taskkill = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "System32", "taskkill.exe");
            using (var killer = Process.Start(new ProcessStartInfo {
                FileName = taskkill,
                Arguments = "/PID " + processId.ToString() + " /T /F",
                UseShellExecute = false,
                CreateNoWindow = true
            })) { killer.WaitForExit(); }
        }
        catch { }
    }

    static IntPtr CreateKillOnCloseJob()
    {
        var job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) return IntPtr.Zero;
        var info = new JobObjectExtendedLimitInformation();
        info.BasicLimitInformation.LimitFlags = 0x2000;
        if (!SetInformationJobObject(job, 9, ref info, (uint)Marshal.SizeOf(typeof(JobObjectExtendedLimitInformation)))) {
            CloseHandle(job);
            return IntPtr.Zero;
        }
        return job;
    }

    public static int Run(string root, string relativeCwd, string executable, string[] argv, int timeoutMs)
    {
        var locks = new List<SafeFileHandle>();
        try {
            string rootPath = Path.GetFullPath(root);
            string cwdPath = Path.GetFullPath(Path.Combine(rootPath, relativeCwd ?? "."));
            if (!IsDescendant(rootPath, cwdPath)) throw new IOException("working directory escapes root");
            locks.Add(LockDirectory(rootPath));
            string suffix = cwdPath.Substring(rootPath.Length).Trim(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            string current = rootPath;
            foreach (string part in suffix.Split(new[] { Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar }, StringSplitOptions.RemoveEmptyEntries)) {
                current = Path.Combine(current, part);
            locks.Add(LockDirectory(current));
            }
            Console.Error.WriteLine("OCW_WINDOWS_ANCHOR_READY");
            var start = new ProcessStartInfo {
                FileName = executable,
                Arguments = String.Join(" ", Array.ConvertAll(argv ?? new string[0], QuoteArgument)),
                WorkingDirectory = cwdPath,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true
            };
            using (var process = Process.Start(start)) {
                var job = CreateKillOnCloseJob();
                if (job != IntPtr.Zero && !AssignProcessToJobObject(job, process.Handle)) { CloseHandle(job); job = IntPtr.Zero; }
                var stdout = process.StandardOutput.ReadToEndAsync();
                var stderr = process.StandardError.ReadToEndAsync();
                if (!process.WaitForExit(timeoutMs)) {
                    if (job != IntPtr.Zero) TerminateJobObject(job, 124);
                    KillTree(process.Id);
                    process.WaitForExit();
                    stdout.Wait();
                    stderr.Wait();
                    Console.Out.Write(stdout.Result);
                    Console.Error.Write(stderr.Result);
                    if (job != IntPtr.Zero) CloseHandle(job);
                    return 124;
                }
                stdout.Wait();
                stderr.Wait();
                Console.Out.Write(stdout.Result);
                Console.Error.Write(stderr.Result);
                if (job != IntPtr.Zero) CloseHandle(job);
                return process.ExitCode;
            }
        }
        catch {
            Console.Error.WriteLine("OCW_WINDOWS_DIRECTORY_ANCHOR_FAILED");
            return 125;
        }
        finally {
            for (int index = locks.Count - 1; index >= 0; index--) locks[index].Dispose();
        }
    }
}
'@

  exit [OcwWindowsAnchor]::Run([string]$inputObject.root, [string]$inputObject.cwd, [string]$inputObject.executable, [string[]]@($inputObject.argv), [int]$inputObject.timeoutMs)
} catch {
  [Console]::Error.WriteLine('OCW_WINDOWS_DIRECTORY_ANCHOR_FAILED')
  exit 125
}
