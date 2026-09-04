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
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class OcwWindowsPathLock
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
    static extern SafeFileHandle CreateFile(string fileName, uint desiredAccess, uint shareMode, IntPtr securityAttributes, uint creationDisposition, uint flagsAndAttributes, IntPtr templateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetFileInformationByHandle(SafeFileHandle handle, out ByHandleFileInformation information);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern uint GetFinalPathNameByHandle(SafeFileHandle handle, System.Text.StringBuilder path, uint length, uint flags);

    static string Canonical(string value)
    {
        var result = (value ?? "").Replace('/', '\\').TrimEnd('\\');
        if (result.StartsWith("\\\\?\\", StringComparison.Ordinal)) result = result.Substring(4);
        return result;
    }

    static SafeFileHandle OpenAndCheck(string path, bool directory, string expected)
    {
        var flags = FileFlagOpenReparsePoint | (directory ? FileFlagBackupSemantics : 0u);
        var handle = CreateFile(path, GenericRead, ShareRead | ShareWrite, IntPtr.Zero, OpenExisting, flags, IntPtr.Zero);
        if (handle.IsInvalid) throw new IOException("path lock failed");
        ByHandleFileInformation info;
        if (!GetFileInformationByHandle(handle, out info)) { handle.Dispose(); throw new IOException("path inspection failed"); }
        if (((info.FileAttributes & FileAttributeDirectory) != 0) != directory || (info.FileAttributes & FileAttributeReparsePoint) != 0) {
            handle.Dispose(); throw new IOException("reparse or wrong file type");
        }
        if (!String.IsNullOrEmpty(expected)) {
            var buffer = new System.Text.StringBuilder(1024);
            if (GetFinalPathNameByHandle(handle, buffer, (uint)buffer.Capacity, 0) == 0 || !String.Equals(Canonical(buffer.ToString()), Canonical(expected), StringComparison.OrdinalIgnoreCase)) {
                handle.Dispose(); throw new IOException("path identity changed");
            }
        }
        return handle;
    }

    static bool Exists(string path)
    {
        try { return File.Exists(path) || Directory.Exists(path); } catch { return false; }
    }

    public static int Run(string root, string parent, string target, string ready, string release, string expectedParent)
    {
        var handles = new List<SafeFileHandle>();
        try {
            var rootPath = Path.GetFullPath(root);
            var parentPath = Path.GetFullPath(parent);
            if (!String.Equals(rootPath, parentPath, StringComparison.OrdinalIgnoreCase) && !parentPath.StartsWith(rootPath.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new IOException("parent escapes root");
            handles.Add(OpenAndCheck(rootPath, true, null));
            var suffix = parentPath.Substring(rootPath.Length).Trim(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            var current = rootPath;
            foreach (var part in suffix.Split(new[] { Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar }, StringSplitOptions.RemoveEmptyEntries)) {
                current = Path.Combine(current, part);
                handles.Add(OpenAndCheck(current, true, String.Equals(current, parentPath, StringComparison.OrdinalIgnoreCase) ? expectedParent : null));
            }
            File.WriteAllText(ready, "OK");
            while (!File.Exists(release)) System.Threading.Thread.Sleep(10);
            return 0;
        } catch (Exception error) {
            try { File.WriteAllText(ready, "ERROR:" + error.Message); } catch { }
            return 125;
        } finally {
            for (var index = handles.Count - 1; index >= 0; index--) handles[index].Dispose();
        }
    }
}
'@

  exit [OcwWindowsPathLock]::Run([string]$inputObject.root, [string]$inputObject.parent, [string]$inputObject.target, [string]$inputObject.ready, [string]$inputObject.release, [string]$inputObject.expectedParent)
} catch {
  try { [System.IO.File]::WriteAllText([string]$inputObject.ready, 'ERROR:broker failure') } catch { }
  exit 125
}
