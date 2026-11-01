param(
  [string]$Payload
)

# Windows ConPTY helper for openclaw-workbench.
#
# WINDOWS_PTY_STATUS: UNVERIFIED. This script has never run on Windows
# (written and reviewed on Linux). It is a real implementation attempt
# using CreatePseudoConsole + CreateProcess with a pseudoconsole
# attribute, not a verified path: Windows CI must validate spawn, input
# pumping, output pumping, cancel (taskkill from the Node provider) and
# exit-code propagation before any real session uses it. Do not report
# this path as working until that validation lands.
#
# Invocation contract (Node side, shell:false, base64 JSON payload):
#   { cwd, argv, cols, rows, env }
# Only these fields are accepted; argv is turned into a CreateProcess
# command line with CommandLineToArgvW quoting, never through a shell.
# cols 1-500, rows 1-200, env keys must match [A-Za-z_][A-Za-z0-9_]*.
# The script prints only the child process output on stdout; failures
# print a single PTY_FAILED line on stderr and exit 1.

$ErrorActionPreference = 'Stop'

try {
  if ([string]::IsNullOrEmpty($Payload)) { throw 'payload is required' }
  $inputObject = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($Payload)) | ConvertFrom-Json

  $cwd = [string]$inputObject.cwd
  $argv = @($inputObject.argv)
  $cols = [int]$inputObject.cols
  $rows = [int]$inputObject.rows
  if ([string]::IsNullOrEmpty($cwd) -or -not (Test-Path -LiteralPath $cwd -PathType Container)) { throw 'cwd is invalid' }
  if ($argv.Count -eq 0) { throw 'argv is empty' }
  foreach ($item in $argv) {
    if ($null -eq $item -or [string]$item -eq '' -or ([string]$item -match "[\0\r\n]")) { throw 'argv entry is invalid' }
  }
  if ($cols -lt 1 -or $cols -gt 500 -or $rows -lt 1 -or $rows -gt 200) { throw 'size is invalid' }
  $envPairs = @()
  $childSystemRoot = $null
  if ($null -ne $inputObject.env) {
    foreach ($property in $inputObject.env.PSObject.Properties) {
      $key = [string]$property.Name
      $value = [string]$property.Value
      if ($key -notmatch '^[A-Za-z_][A-Za-z0-9_]{0,127}$' -or $value.Length -gt 4096 -or ($value -match "[\0\r\n]")) { throw 'env entry is invalid' }
      $envPairs += "$key=$value"
      if ($key -eq 'SystemRoot') { $childSystemRoot = $value }
    }
  }

  function Quote-Arg([string]$a) {
    if ($a -eq '') { return '""' }
    if ($a -notmatch '[\s"]') { return $a }
    $out = '"'
    $slashes = 0
    foreach ($ch in $a.ToCharArray()) {
      if ($ch -eq '\') { $slashes++; continue }
      if ($ch -eq '"') { $out += ('\' * ($slashes * 2 + 1)) + '"'; $slashes = 0; continue }
      $out += ('\' * $slashes) + $ch; $slashes = 0
    }
    $out += ('\' * ($slashes * 2)) + '"'
    return $out
  }
  $commandLine = ($argv | ForEach-Object { Quote-Arg ([string]$_) }) -join ' '

  $envBlock = $null
  if ($envPairs.Count -gt 0) {
    $envText = ($envPairs | ForEach-Object { "$_`0" }) -join ''
    $envText += "`0"
    $envBlock = [System.Text.Encoding]::Unicode.GetBytes($envText)
  }

  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class OcwConPty
{
    public const uint ProcThreadAttributePseudoConsole = 0x00020016;
    public const uint ExtendedStartupinfoPresent = 0x00080000;
    public const uint CreateUnicodeEnvironment = 0x00000400;
    public const uint PseudoConsoleInheritCursor = 1;
    public const uint WaitInfinite = 0xFFFFFFFF;

    [StructLayout(LayoutKind.Sequential)]
    public struct Coord
    {
        public short X;
        public short Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct SecurityAttributes
    {
        public int nLength;
        public IntPtr lpSecurityDescriptor;
        public bool bInheritHandle;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct StartupInfo
    {
        public uint cb;
        public IntPtr lpReserved;
        public IntPtr lpDesktop;
        public IntPtr lpTitle;
        public uint dwX;
        public uint dwY;
        public uint dwXSize;
        public uint dwYSize;
        public uint dwXCountChars;
        public uint dwYCountChars;
        public uint dwFillAttribute;
        public uint dwFlags;
        public ushort wShowWindow;
        public ushort cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct StartupInfoEx
    {
        public StartupInfo StartupInfo;
        public IntPtr lpAttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct ProcessInformation
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CreatePipe(out IntPtr hReadPipe, out IntPtr hWritePipe, ref SecurityAttributes lpPipeAttributes, uint nSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern int CreatePseudoConsole(Coord size, IntPtr hInput, IntPtr hOutput, uint dwFlags, out IntPtr phPC);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern void ClosePseudoConsole(IntPtr hPC);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool InitializeProcThreadAttributeList(IntPtr lpAttributeList, int dwAttributeCount, int dwFlags, ref IntPtr lpSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool UpdateProcThreadAttribute(IntPtr lpAttributeList, uint dwFlags, IntPtr attribute, IntPtr lpValue, IntPtr cbSize, IntPtr lpPreviousValue, IntPtr lpReturnSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern void DeleteProcThreadAttributeList(IntPtr lpAttributeList);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CreateProcess(string lpApplicationName, StringBuilder lpCommandLine, IntPtr lpProcessAttributes, IntPtr lpThreadAttributes, bool bInheritHandles, uint dwCreationFlags, byte[] lpEnvironment, string lpCurrentDirectory, ref StartupInfoEx lpStartupInfo, out ProcessInformation lpProcessInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr hObject);
}
'@

  function New-InheritPipe {
    $sa = New-Object OcwConPty+SecurityAttributes
    $sa.nLength = [System.Runtime.InteropServices.Marshal]::SizeOf($sa)
    $sa.bInheritHandle = $true
    $read = [IntPtr]::Zero
    $write = [IntPtr]::Zero
    if (-not [OcwConPty]::CreatePipe([ref]$read, [ref]$write, [ref]$sa, 0)) { throw 'CreatePipe failed' }
    return @{ Read = $read; Write = $write }
  }

  $inputPipe = New-InheritPipe
  $outputPipe = New-InheritPipe
  $size = New-Object OcwConPty+Coord
  $size.X = [int16]$cols
  $size.Y = [int16]$rows
  $hPC = [IntPtr]::Zero
  $hr = [OcwConPty]::CreatePseudoConsole($size, $inputPipe.Read, $outputPipe.Write, 0, [ref]$hPC)
  if ($hr -ne 0 -or $hPC -eq [IntPtr]::Zero) { throw "CreatePseudoConsole failed (hr=$hr)" }

  $attrSize = [IntPtr]::Zero
  [void][OcwConPty]::InitializeProcThreadAttributeList([IntPtr]::Zero, 1, 0, [ref]$attrSize)
  $attrList = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($attrSize)
  try {
    if (-not [OcwConPty]::InitializeProcThreadAttributeList($attrList, 1, 0, [ref]$attrSize)) { throw 'InitializeProcThreadAttributeList failed' }
    $pcPtr = [System.Runtime.InteropServices.Marshal]::AllocHGlobal([IntPtr]::Size)
    [System.Runtime.InteropServices.Marshal]::WriteIntPtr($pcPtr, $hPC)
    try {
      if (-not [OcwConPty]::UpdateProcThreadAttribute($attrList, 0, [OcwConPty]::ProcThreadAttributePseudoConsole, $pcPtr, [IntPtr][IntPtr]::Size, [IntPtr]::Zero, [IntPtr]::Zero)) { throw 'UpdateProcThreadAttribute failed' }
      $startup = New-Object OcwConPty+StartupInfoEx
      # cb MUST be sizeof(STARTUPINFOEX), not sizeof(STARTUPINFO):
      # Microsoft's STARTUPINFOEX docs state this explicitly ("Be sure
      # to set the cb member of the STARTUPINFO structure to
      # sizeof(STARTUPINFOEX)"), and the official ConPTY sample does
      # the same.
      # NOTE (PowerShell nested-struct trap, found by the Win32 87
      # failure): $startup.StartupInfo.cb = X does NOT persist, because
      # StartupInfo is a value-type field -- PowerShell hands back a
      # COPY of the nested struct, the cb assignment lands on the copy,
      # and it is discarded, leaving cb = 0, which makes CreateProcess
      # fail with ERROR_INVALID_PARAMETER (87). The working pattern is
      # copy-modify-reassign: pull the nested struct into a variable,
      # set cb there, and write the whole struct back. (Top-level field
      # assignment does persist -- Coord X/Y and SecurityAttributes
      # nLength prove it -- only the nested level is lost.)
      # NOTE: SizeOf must likewise be given a structure INSTANCE.
      # Passing the type literal binds PowerShell to the SizeOf(object)
      # overload, which throws "Type 'System.RuntimeType' cannot be
      # marshaled" -- the failure of the earliest Windows runs.
      $si = $startup.StartupInfo
      $si.cb = [uint32][System.Runtime.InteropServices.Marshal]::SizeOf((New-Object OcwConPty+StartupInfoEx))
      $startup.StartupInfo = $si
      $startup.lpAttributeList = $attrList
      $procInfo = New-Object OcwConPty+ProcessInformation
      $flags = [OcwConPty]::ExtendedStartupinfoPresent -bor [OcwConPty]::CreateUnicodeEnvironment
      $cmd = New-Object System.Text.StringBuilder($commandLine)
      # bInheritHandles must be TRUE: the pseudoconsole handle travels to
      # the child through the attribute list, which is only applied to
      # inheritable handles. FALSE leaves the child without a console
      # (or fails CreateProcess outright), which is the classic ConPTY
      # P/Invoke failure mode. The Win32 code is attached so any
      # further CreateProcess failure is precisely identified instead
      # of a bare message (SetLastError=true is set on the import).
      # The booleans below exist to pin down ERROR_PATH_NOT_FOUND (3):
      # they say whether the working directory and the cmd.exe the
      # child resolves to actually exist, without logging argv values.
      if (-not [OcwConPty]::CreateProcess($null, $cmd, [IntPtr]::Zero, [IntPtr]::Zero, $true, $flags, $envBlock, $cwd, [ref]$startup, [ref]$procInfo)) {
        $win32 = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
        $cwdExists = Test-Path -LiteralPath $cwd -PathType Container
        $sysRoot = if ($childSystemRoot) { $childSystemRoot } else { $env:SystemRoot }
        $cmdExists = $false
        if ($sysRoot) { $cmdExists = Test-Path -LiteralPath (Join-Path $sysRoot 'System32\cmd.exe') -PathType Leaf }
        # Bisection probes (diagnostic only -- the session still fails
        # with the original error below). Each probe reuses the same
        # HPCON, attribute list, flags, and command line, and nulls
        # out one input, so the pattern localizes the fault:
        #   noEnv+noCwd ok, env+noCwd fail, noEnv+cwd ok => env block
        #   noEnv+noCwd ok, env+noCwd ok, noEnv+cwd fail => cwd
        #   all fail => shared cmdline/startup/attribute inputs
        # A fresh StringBuilder is built per probe because CreateProcess
        # may modify the command-line buffer in place. Probe children
        # are the same echo command; their handles are closed at once
        # and never waited on, and their console output is discarded
        # when the helper exits. No argv values are reported.
        # Second-round probes (Win32 3 with cwd, 123 without): cwd is
        # the only input that changes the error, yet Test-Path says it
        # exists -- so this round also prints the cwd value itself and
        # the helper's inherited location, and probes a guaranteed
        # directory (SystemRoot) and a full-path application name, to
        # separate "this temp path is the problem" from "cwd passing
        # or module resolution is the problem".
        function Test-CreateProcess($envArg, $cwdArg, $appArg) {
          $pi = New-Object OcwConPty+ProcessInformation
          $probeCmd = New-Object System.Text.StringBuilder($commandLine)
          $ok = [OcwConPty]::CreateProcess($appArg, $probeCmd, [IntPtr]::Zero, [IntPtr]::Zero, $true, $flags, $envArg, $cwdArg, [ref]$startup, [ref]$pi)
          $code = if ($ok) { 0 } else { [System.Runtime.InteropServices.Marshal]::GetLastWin32Error() }
          if ($pi.hProcess -ne [IntPtr]::Zero) { [void][OcwConPty]::CloseHandle($pi.hProcess) }
          if ($pi.hThread -ne [IntPtr]::Zero) { [void][OcwConPty]::CloseHandle($pi.hThread) }
          return $code
        }
        $probeNoEnvNoCwd = Test-CreateProcess $null $null $null
        $probeEnvNoCwd = Test-CreateProcess $envBlock $null $null
        $probeNoEnvCwd = Test-CreateProcess $null $cwd $null
        $probeSysRootCwd = $null
        $probeFullApp = $null
        if ($sysRoot) {
          $probeSysRootCwd = Test-CreateProcess $null $sysRoot $null
          $probeFullApp = Test-CreateProcess $null $cwd (Join-Path $sysRoot 'System32\cmd.exe')
        }
        $here = (Get-Location).Path
        throw "CreateProcess failed (Win32 $win32, cb=$($startup.StartupInfo.cb), cwd=[$cwd], here=[$here], cwdExists=$cwdExists, cmdExists=$cmdExists, envCount=$($envPairs.Count), hpc=$($hPC -ne [IntPtr]::Zero), attr=$($attrList -ne [IntPtr]::Zero), probeNoEnvNoCwd=$probeNoEnvNoCwd, probeEnvNoCwd=$probeEnvNoCwd, probeNoEnvCwd=$probeNoEnvCwd, probeSysRootCwd=$probeSysRootCwd, probeFullApp=$probeFullApp)"
      }
    } finally {
      [System.Runtime.InteropServices.Marshal]::FreeHGlobal($pcPtr)
    }
  } finally {
    [OcwConPty]::DeleteProcThreadAttributeList($attrList)
    [System.Runtime.InteropServices.Marshal]::FreeHGlobal($attrList)
  }
  [void][OcwConPty]::CloseHandle($procInfo.hThread)
  # Keep hPC open until the child exits: closing it right after
  # CreateProcess is not the sample order and risks tearing the console
  # session down early. It is closed in the cleanup below.

  $outputStream = New-Object System.IO.FileStream((New-Object Microsoft.Win32.SafeHandles.SafeFileHandle($outputPipe.Read, $false)), [System.IO.FileAccess]::Read)
  $inputStream = New-Object System.IO.FileStream((New-Object Microsoft.Win32.SafeHandles.SafeFileHandle($inputPipe.Write, $false)), [System.IO.FileAccess]::Write)
  $consoleOut = [Console]::OpenStandardOutput()
  $consoleIn = [Console]::OpenStandardInput()

  $outputPump = [powershell]::Create().AddScript({
    param($from, $to)
    $buffer = New-Object byte[] 65536
    try {
      while ($true) {
        $n = $from.Read($buffer, 0, $buffer.Length)
        if ($n -le 0) { break }
        $to.Write($buffer, 0, $n)
        $to.Flush()
      }
    } catch { }
  }).AddParameters(@{ from = $outputStream; to = $consoleOut })
  $inputPump = [powershell]::Create().AddScript({
    param($from, $to)
    $buffer = New-Object byte[] 65536
    try {
      while ($true) {
        $n = $from.Read($buffer, 0, $buffer.Length)
        if ($n -le 0) { break }
        $to.Write($buffer, 0, $n)
        $to.Flush()
      }
    } catch { }
  }).AddParameters(@{ from = $consoleIn; to = $inputStream })
  $outputJob = $outputPump.BeginInvoke()
  $inputJob = $inputPump.BeginInvoke()
  try {
    [void][OcwConPty]::WaitForSingleObject($procInfo.hProcess, [OcwConPty]::WaitInfinite)
    $exitCode = 0
    if (-not [OcwConPty]::GetExitCodeProcess($procInfo.hProcess, [ref]$exitCode)) { throw 'GetExitCodeProcess failed' }
  } finally {
    try { $inputStream.Close() } catch { }
    try { $outputPump.Stop() } catch { }
    try { $inputPump.Stop() } catch { }
    try { $outputPump.Dispose() } catch { }
    try { $inputPump.Dispose() } catch { }
    try { $outputStream.Close() } catch { }
    [void][OcwConPty]::CloseHandle($procInfo.hProcess)
    [OcwConPty]::ClosePseudoConsole($hPC)
    [void][OcwConPty]::CloseHandle($inputPipe.Read)
    [void][OcwConPty]::CloseHandle($outputPipe.Write)
  }
  [Environment]::Exit([int]$exitCode)
} catch {
  [Console]::Error.WriteLine("PTY_FAILED: $($_.Exception.Message)")
  [Environment]::Exit(1)
}
