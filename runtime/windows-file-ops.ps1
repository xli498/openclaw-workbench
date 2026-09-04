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
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class OcwWindowsFileOps
{
    const uint GenericRead = 0x80000000;
    const uint GenericWrite = 0x40000000;
    const uint Delete = 0x00010000;
    const uint ShareRead = 0x00000001;
    const uint ShareWrite = 0x00000002;
    const uint OpenExisting = 3;
    const uint CreateNew = 1;
    const uint FileFlagBackupSemantics = 0x02000000;
    const uint FileFlagOpenReparsePoint = 0x00200000;
    const uint FileAttributeDirectory = 0x00000010;
    const uint FileAttributeReparsePoint = 0x00000400;

    [StructLayout(LayoutKind.Sequential)]
    struct ByHandleFileInformation { public uint FileAttributes; public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime; public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime; public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime; public uint VolumeSerialNumber; public uint FileSizeHigh; public uint FileSizeLow; public uint NumberOfLinks; public uint FileIndexHigh; public uint FileIndexLow; }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetFileInformationByHandle(SafeFileHandle handle, out ByHandleFileInformation info);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern uint GetFinalPathNameByHandle(SafeFileHandle handle, StringBuilder path, uint length, uint flags);
    const int FileRenameInfo = 3;
    const int FileDispositionInfo = 4;
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetFileInformationByHandle(SafeFileHandle handle, int type, IntPtr info, uint size);

    static string Canonical(string value) { var result = (value ?? "").Replace('/', '\\').TrimEnd('\\'); return result.StartsWith("\\\\?\\", StringComparison.Ordinal) ? result.Substring(4) : result; }
    static string FinalPath(SafeFileHandle handle) { var buffer = new StringBuilder(1024); if (GetFinalPathNameByHandle(handle, buffer, (uint)buffer.Capacity, 0) == 0) throw new IOException("final path unavailable"); return Canonical(buffer.ToString()); }
    static SafeFileHandle OpenDirectory(string path, string expected) {
        var handle = CreateFile(path, GenericRead, ShareRead | ShareWrite, IntPtr.Zero, OpenExisting, FileFlagBackupSemantics | FileFlagOpenReparsePoint, IntPtr.Zero);
        if (handle.IsInvalid) throw new IOException("directory unavailable");
        ByHandleFileInformation info; if (!GetFileInformationByHandle(handle, out info) || (info.FileAttributes & FileAttributeDirectory) == 0 || (info.FileAttributes & FileAttributeReparsePoint) != 0 || (!String.IsNullOrEmpty(expected) && !String.Equals(FinalPath(handle), Canonical(expected), StringComparison.OrdinalIgnoreCase))) { handle.Dispose(); throw new IOException("directory identity changed or is a reparse point"); }
        return handle;
    }
    static List<SafeFileHandle> LockParents(string root, string parent, string expectedParent) {
        var result = new List<SafeFileHandle>(); var rootPath = Path.GetFullPath(root); var parentPath = Path.GetFullPath(parent);
        if (!String.Equals(rootPath, parentPath, StringComparison.OrdinalIgnoreCase) && !parentPath.StartsWith(rootPath.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new IOException("parent escapes root");
        result.Add(OpenDirectory(rootPath, null)); var suffix = parentPath.Substring(rootPath.Length).Trim(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar); var current = rootPath;
        foreach (var part in suffix.Split(new[] { Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar }, StringSplitOptions.RemoveEmptyEntries)) { current = Path.Combine(current, part); result.Add(OpenDirectory(current, String.Equals(current, parentPath, StringComparison.OrdinalIgnoreCase) ? expectedParent : null)); }
        return result;
    }
    static byte[] ReadFile(SafeFileHandle parent, string path) {
        using (var handle = CreateFile(path, GenericRead, ShareRead | ShareWrite, IntPtr.Zero, OpenExisting, FileFlagOpenReparsePoint, IntPtr.Zero)) {
            if (handle.IsInvalid) throw new IOException("file unavailable"); ByHandleFileInformation info; if (!GetFileInformationByHandle(handle, out info) || (info.FileAttributes & FileAttributeDirectory) != 0 || (info.FileAttributes & FileAttributeReparsePoint) != 0) throw new IOException("file is not regular");
            using (var stream = new FileStream(handle, FileAccess.Read, 4096, false)) using (var memory = new MemoryStream()) { stream.CopyTo(memory); return memory.ToArray(); }
        }
    }
    static bool RegularFileExists(string path) {
        try { using (var handle = CreateFile(path, GenericRead, ShareRead | ShareWrite, IntPtr.Zero, OpenExisting, FileFlagOpenReparsePoint, IntPtr.Zero)) { if (handle.IsInvalid) return false; ByHandleFileInformation info; return GetFileInformationByHandle(handle, out info) && (info.FileAttributes & FileAttributeDirectory) == 0 && (info.FileAttributes & FileAttributeReparsePoint) == 0; } }
        catch { return false; }
    }
    static string Hash(byte[] bytes) { using (var sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant(); }
    static void RenameByHandle(SafeFileHandle source, string target, bool replace) {
        var pointerOffset = IntPtr.Size == 8 ? 8 : 4;
        var lengthOffset = pointerOffset + IntPtr.Size;
        var nameOffset = lengthOffset + 4;
        var nameBytes = Encoding.Unicode.GetBytes(Path.GetFullPath(target));
        // FileNameLength excludes the NUL, but the native API also reads the
        // buffer as a UTF-16 string on this Windows version.
        var size = nameOffset + nameBytes.Length + 2;
        var memory = Marshal.AllocHGlobal(size);
        try {
            for (var index = 0; index < size; index++) Marshal.WriteByte(memory, index, 0);
            Marshal.WriteByte(memory, 0, replace ? (byte)1 : (byte)0);
            Marshal.WriteInt32(memory, lengthOffset, nameBytes.Length);
            Marshal.Copy(nameBytes, 0, IntPtr.Add(memory, nameOffset), nameBytes.Length);
            if (!SetFileInformationByHandle(source, FileRenameInfo, memory, (uint)size)) throw new IOException("atomic rename failed: " + Marshal.GetLastWin32Error().ToString());
        } finally { Marshal.FreeHGlobal(memory); }
    }
    static void DeleteByHandle(SafeFileHandle handle) {
        var memory = Marshal.AllocHGlobal(1);
        try {
            Marshal.WriteByte(memory, 0, 1);
            if (!SetFileInformationByHandle(handle, FileDispositionInfo, memory, 1)) throw new IOException("atomic delete failed: " + Marshal.GetLastWin32Error().ToString());
        } finally { Marshal.FreeHGlobal(memory); }
    }
    static SafeFileHandle CreateTemporary(string parent, string name) { var path = Path.Combine(parent, name); var handle = CreateFile(path, GenericRead | GenericWrite | Delete, ShareRead, IntPtr.Zero, CreateNew, FileFlagOpenReparsePoint, IntPtr.Zero); if (handle.IsInvalid) throw new IOException("temporary file unavailable"); return handle; }
    static void WriteTemporary(SafeFileHandle handle, byte[] bytes) { using (var stream = new FileStream(handle, FileAccess.Write, 4096, false)) { stream.Write(bytes, 0, bytes.Length); stream.Flush(true); } }
    static void AssertChildOfParent(string parent, string value, string label) { if (String.IsNullOrEmpty(value)) return; var expected = Path.GetFullPath(parent); var candidate = Path.GetFullPath(value); if (!String.Equals(Path.GetDirectoryName(candidate), expected, StringComparison.OrdinalIgnoreCase)) throw new IOException(label + " escapes parent"); }

    public static int Run(string operation, string root, string parent, string target, string source, string expectedParent, string expectedSourceHash, string expectedTargetHash, string contentBase64, bool replaceIfExists, bool expectTargetMissing)
    {
        List<SafeFileHandle> parents = null; SafeFileHandle temporary = null; string temporaryPath = null;
        try {
            AssertChildOfParent(parent, target, "target"); AssertChildOfParent(parent, source, "source");
            parents = LockParents(root, parent, expectedParent);
            if (operation == "read") { var bytes = ReadFile(parents[parents.Count - 1], target); Console.Out.Write(Convert.ToBase64String(bytes)); return 0; }
            if (operation == "delete") { using (var file = CreateFile(target, Delete, ShareRead | ShareWrite, IntPtr.Zero, OpenExisting, FileFlagOpenReparsePoint, IntPtr.Zero)) { if (file.IsInvalid) return 0; ByHandleFileInformation info; if (!GetFileInformationByHandle(file, out info) || (info.FileAttributes & FileAttributeDirectory) != 0 || (info.FileAttributes & FileAttributeReparsePoint) != 0) throw new IOException("file is not regular"); DeleteByHandle(file); return 0; } }
            var name = ".ocw-temp-" + Guid.NewGuid().ToString("N"); temporaryPath = Path.Combine(parent, name); temporary = CreateTemporary(parent, name);
            if (operation == "write") { if (!String.IsNullOrEmpty(expectedTargetHash) && (!RegularFileExists(target) || Hash(ReadFile(parents[parents.Count - 1], target)) != expectedTargetHash)) throw new IOException("target changed"); if (expectTargetMissing && RegularFileExists(target)) throw new IOException("target changed"); var bytes = Convert.FromBase64String(contentBase64 ?? ""); WriteTemporary(temporary, bytes); temporary.Dispose(); temporary = null; temporary = CreateFile(Path.Combine(parent, name), GenericRead | Delete, ShareRead, IntPtr.Zero, OpenExisting, FileFlagOpenReparsePoint, IntPtr.Zero); if (temporary.IsInvalid) throw new IOException("temporary file unavailable"); RenameByHandle(temporary, target, replaceIfExists); temporary.Dispose(); temporary = null; return 0; }
            if (operation == "replace") { var bytes = ReadFile(parents[parents.Count - 1], source); var targetExists = RegularFileExists(target); if (!String.IsNullOrEmpty(expectedSourceHash) && Hash(bytes) != expectedSourceHash) throw new IOException("source changed"); if (!String.IsNullOrEmpty(expectedTargetHash) && (!targetExists || Hash(ReadFile(parents[parents.Count - 1], target)) != expectedTargetHash)) throw new IOException("target changed"); WriteTemporary(temporary, bytes); temporary.Dispose(); temporary = null; temporary = CreateFile(Path.Combine(parent, name), GenericRead | Delete, ShareRead, IntPtr.Zero, OpenExisting, FileFlagOpenReparsePoint, IntPtr.Zero); if (temporary.IsInvalid) throw new IOException("temporary file unavailable"); RenameByHandle(temporary, target, targetExists); temporary.Dispose(); temporary = null; return 0; }
            throw new IOException("unknown operation");
        } catch (Exception error) { Console.Error.WriteLine(error.Message); return 125; }
        finally { if (temporary != null) temporary.Dispose(); if (!String.IsNullOrEmpty(temporaryPath)) { try { File.Delete(temporaryPath); } catch { } } if (parents != null) for (var index = parents.Count - 1; index >= 0; index--) parents[index].Dispose(); }
    }
}
'@

  exit [OcwWindowsFileOps]::Run([string]$inputObject.operation, [string]$inputObject.root, [string]$inputObject.parent, [string]$inputObject.target, [string]$inputObject.source, [string]$inputObject.expectedParent, [string]$inputObject.expectedSourceHash, [string]$inputObject.expectedTargetHash, [string]$inputObject.contentBase64, [bool]$inputObject.replaceIfExists, [bool]$inputObject.expectTargetMissing)
} catch {
  [Console]::Error.WriteLine('windows file operation failed')
  exit 125
}
