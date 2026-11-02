param(
  [string]$Payload
)

# Windows ConPTY helper for openclaw-workbench.
#
# WINDOWS_PTY_STATUS: EXECUTION VERIFIED ON WINDOWS CI (PR #45,
# 2026-11-02) for spawn, input/output pumping, cancel, and exit-code
# propagation. ConPTY RESIZE IS WIRED IN THIS SLICE via a named-pipe
# control channel (see the provider header); its Windows CI execution
# verification lives in tests/windows-pty-resize.test.mjs and is
# reported per-PR, not claimed here ahead of that run.
#
# Invocation contract (Node side, shell:false, base64 JSON payload):
#   { cwd, argv, cols, rows, controlPipe, env }
# Only these fields are accepted; argv is turned into a CreateProcess
# command line with CommandLineToArgvW quoting, never through a shell.
# cols 1-500, rows 1-200, env keys must match [A-Za-z_][A-Za-z0-9_]*.
# controlPipe, when present, must match ^ocw-pty-[0-9a-f-]{36}$ or the
# spawn fails (never a silent fallback to a no-resize session); when
# absent the helper runs the legacy one-shot path with no control
# channel and no READY line (the provider always sends it, so this
# path is only for foreign callers). With a control pipe, the helper
# creates the pipe server BEFORE CreateProcess, starts a control
# runspace after CreateProcess, and writes exactly one READY line to
# stdout BEFORE the child output pump starts; the provider strips
# exactly that line. The script prints only READY plus child process
# output on stdout; failures print a single PTY_FAILED line on stderr
# and exit 1.

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
  # Control pipe name: a fresh per-session UUID from the provider.
  # Present-but-malformed is a payload error, never a fallback: a
  # session whose resize channel cannot be named must not start as a
  # silent no-resize session. Absent means a legacy foreign caller.
  $controlPipe = $null
  if ($null -ne $inputObject.controlPipe -and [string]$inputObject.controlPipe -ne '') {
    $controlPipe = [string]$inputObject.controlPipe
    if ($controlPipe -notmatch '^ocw-pty-[0-9a-f-]{36}$') { throw 'control pipe name is invalid' }
  }
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
    # Windows environment names are case-insensitive and the block
    # is conventionally sorted. The provider already collapses
    # case-variant duplicates, but JSON property order is not a
    # contract, so sort here by key in case-insensitive Unicode
    # (ordinal) order: the block is then identical regardless of
    # the caller's insertion order. Keys are ASCII-only by the
    # validation above, so OrdinalIgnoreCase is exact here.
    $envKeys = @($envPairs | ForEach-Object { $_.Substring(0, $_.IndexOf('=')) })
    $envItems = [string[]]$envPairs
    [Array]::Sort($envKeys, $envItems, [System.StringComparer]::OrdinalIgnoreCase)
    $envPairs = $envItems
    $envText = ($envPairs | ForEach-Object { "$_`0" }) -join ''
    $envText += "`0"
    $envBlock = [System.Text.Encoding]::Unicode.GetBytes($envText)
  }

  # Control pipe server, created BEFORE CreateProcess so the channel
  # exists for the whole child lifetime. ACL is an explicit
  # PipeSecurity granting FullControl to the current user SID only:
  # no allow entry for anyone else means no one else can connect
  # (absence of an allow entry denies). This is a MUST, not a
  # nice-to-have: the pipe accepts resize commands for a live
  # console. The .NET default is NOT relied on. The server object
  # lives at script scope so the cleanup below can dispose it.
  # Cross-user rejection is code-reviewed, not CI-executed: the
  # hosted runner offers no second credential to connect with.
  $controlServer = $null
  $controlPump = $null
  $controlJob = $null
  $controlState = [hashtable]::Synchronized(@{ connected = $false; closeRequested = $false })
  if ($null -ne $controlPipe) {
    $currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $pipeSecurity = New-Object System.IO.Pipes.PipeSecurity
    $pipeSecurity.AddAccessRule((New-Object System.IO.Pipes.PipeAccessRule($currentSid, [System.IO.Pipes.PipeAccessRights]::FullControl, [System.Security.AccessControl.AccessControlType]::Allow)))
    $controlServer = New-Object System.IO.Pipes.NamedPipeServerStream($controlPipe, [System.IO.Pipes.PipeDirection]::InOut, 1, [System.IO.Pipes.PipeTransmissionMode]::Byte, [System.IO.Pipes.PipeOptions]::None, 0, 0, $pipeSecurity)
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
    public static extern int ResizePseudoConsole(IntPtr hPC, Coord size);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);

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

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CancelIoEx(IntPtr hFile, IntPtr lpOverlapped);
}
'@

  function New-InheritPipe {
    $sa = New-Object OcwConPty+SecurityAttributes
    $sa.nLength = [System.Runtime.InteropServices.Marshal]::SizeOf($sa)
    # MS ConPTY sample order: pipes are created NON-inheritable (NULL
    # security attributes in the sample). The pseudoconsole handle
    # travels to the child through the attribute list, not through
    # ordinary handle inheritance, so inheritable pipes here would only
    # let the child or its descendants hold extra pipe ends (which also
    # blocks EOF on the output reader).
    $sa.bInheritHandle = $false
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
    # PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE takes the pseudoconsole
    # handle itself, not a pointer to it: the P/Invoke lpValue is
    # already an IntPtr, so wrapping $hPC in an extra AllocHGlobal
    # pointer (the previous code) hands CreateProcess an invalid
    # pseudoconsole value, which the client then fails to initialize
    # with (historically 0xC0000142). Pass $hPC directly.
    if (-not [OcwConPty]::UpdateProcThreadAttribute($attrList, 0, [OcwConPty]::ProcThreadAttributePseudoConsole, $hPC, [IntPtr][IntPtr]::Size, [IntPtr]::Zero, [IntPtr]::Zero)) { throw 'UpdateProcThreadAttribute failed' }
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
      # bInheritHandles is FALSE: the pseudoconsole handle travels to
      # the child through the attribute list, which is not ordinary
      # handle inheritance; the MS ConPTY sample creates the client
      # with bInheritHandles = FALSE and non-inheritable pipes.
      # (An earlier version of this script claimed TRUE was required;
      # that conflated the attribute-list mechanism with inheritance.)
      # Application-name resolution: a bare module name (no directory
      # separator) relies on CreateProcess's own search, which fails in
      # this hosted context -- proven by failure-path probes on Windows
      # CI: bare name -> Win32 3 (explicit cwd) / 123 (null cwd)
      # regardless of env, while the full System32 path -> 0 with
      # everything else identical. So bare names are resolved to a full
      # path first: a real file under System32 (existence-guarded, so
      # only genuine system binaries take this path), else the first
      # Get-Command match over PATH. If resolution fails, appName stays
      # NULL (previous behavior). The child still sees the original
      # command line unchanged.
      $appName = $null
      $firstArg = [string]$argv[0]
      if ($firstArg -notmatch '[\\/]') {
        if ($childSystemRoot) {
          $sysCandidate = Join-Path $childSystemRoot "System32\$firstArg"
          if (Test-Path -LiteralPath $sysCandidate -PathType Leaf) { $appName = $sysCandidate }
        }
        if (-not $appName) {
          try {
            $found = @(Get-Command $firstArg -ErrorAction Stop)
            if ($found.Count -gt 0 -and $found[0].Source) { $appName = [string]$found[0].Source }
          } catch { }
        }
      }
      if (-not [OcwConPty]::CreateProcess($appName, $cmd, [IntPtr]::Zero, [IntPtr]::Zero, $false, $flags, $envBlock, $cwd, [ref]$startup, [ref]$procInfo)) {
        $win32 = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
        throw "CreateProcess failed (Win32 $win32, cb=$($startup.StartupInfo.cb))"
      }
      # MS ConPTY sample order: bInheritHandles is FALSE (the
      # pseudoconsole travels via the attribute list, not inheritance)
      # and, once CreateProcess succeeds, the helper immediately
      # releases the ConPTY-side pipe ends it handed to
      # CreatePseudoConsole ($inputPipe.Read, $outputPipe.Write). The
      # host ends ($inputPipe.Write, $outputPipe.Read) stay open below.
      # Holding the ConPTY-side ends would keep the output reader from
      # ever seeing EOF. Zeroed so the cleanup below cannot close them
      # a second time.
      [void][OcwConPty]::CloseHandle($inputPipe.Read)
      [void][OcwConPty]::CloseHandle($outputPipe.Write)
      $inputPipe.Read = [IntPtr]::Zero
      $outputPipe.Write = [IntPtr]::Zero
  } finally {
    [OcwConPty]::DeleteProcThreadAttributeList($attrList)
    [System.Runtime.InteropServices.Marshal]::FreeHGlobal($attrList)
  }
  [void][OcwConPty]::CloseHandle($procInfo.hThread)
  # Keep hPC open until the child exits: closing it right after
  # CreateProcess is not the sample order and risks tearing the console
  # session down early. It is closed in the cleanup below.

  # Control runspace: blocks on WaitForConnection first (the pipe
  # server already exists), then serves resize/close JSON lines until
  # the pipe disconnects. It NEVER calls Environment.Exit and NEVER
  # closes the HPC: the main thread owns process exit and HPC
  # lifetime. It is never Stop()ed synchronously (Q1 lesson): if it
  # is still blocked when the main thread finishes, process exit
  # terminates it, and the cleanup below only EndInvokes it when a
  # zero-time check shows it already finished.
  if ($null -ne $controlServer) {
    $controlPump = [powershell]::Create().AddScript({
      param($server, $hPC, $procHandle, $state)
      try {
        $server.WaitForConnection()
        $state.connected = $true
        try { [Console]::Error.WriteLine('PTY_CONTROL: connected') } catch { }
        $reader = New-Object System.IO.StreamReader($server, [System.Text.Encoding]::UTF8)
        # No-BOM UTF-8: [Text.Encoding]::UTF8 emits a BOM before the
        # first frame, and the provider's JSON.parse rejects a
        # BOM-prefixed line, which silently dropped every first ack
        # (resize timeout, never a nack) in the first Windows CI run.
        $writer = New-Object System.IO.StreamWriter($server, (New-Object System.Text.UTF8Encoding($false)))
        $writer.AutoFlush = $true
        while ($true) {
          $line = $null
          try { $line = $reader.ReadLine() } catch { break }
          if ($null -eq $line) { break }
          if ($line.Length -gt 4096) {
            try { $writer.WriteLine('{"id":null,"ok":false,"error":"PTY_CONTROL_INVALID"}') } catch { break }
            continue
          }
          $msg = $null
          try { $msg = $line | ConvertFrom-Json } catch { }
          if ($null -eq $msg) {
            try { $writer.WriteLine('{"id":null,"ok":false,"error":"PTY_CONTROL_INVALID"}') } catch { break }
            continue
          }
          # Strict integer gate: ConvertFrom-Json yields [int]/[long]
          # for JSON integers and [double] for fractions, and a bare
          # [int] cast would ROUND a fraction into range. Fractions
          # are rejected here, not rounded into a valid size.
          $id = $null
          if ($msg.id -is [int] -or $msg.id -is [long]) { $id = [int]$msg.id }
          $idJson = 'null'
          if ($null -ne $id) { $idJson = "$id" }
          if ($msg.type -eq 'resize') {
            $ok = $false
            $cols = 0
            $rows = 0
            if (($msg.cols -is [int] -or $msg.cols -is [long]) -and ($msg.rows -is [int] -or $msg.rows -is [long])) {
              $cols = [int]$msg.cols
              $rows = [int]$msg.rows
            }
            if ($cols -ge 1 -and $cols -le 500 -and $rows -ge 1 -and $rows -le 200) {
              $coord = New-Object OcwConPty+Coord
              $coord.X = [int16]$cols
              $coord.Y = [int16]$rows
              $hr = -1
              try { $hr = [OcwConPty]::ResizePseudoConsole($hPC, $coord) } catch { $hr = -1 }
              if ($hr -eq 0) { $ok = $true }
            }
            if ($ok) { $ack = "{`"id`":$idJson,`"ok`":true,`"cols`":$cols,`"rows`":$rows}" } else { $ack = "{`"id`":$idJson,`"ok`":false,`"error`":`"PTY_RESIZE_FAILED`"}" }
            try { $writer.WriteLine($ack) } catch { break }
          } elseif ($msg.type -eq 'close') {
            try { $writer.WriteLine("{`"id`":$idJson,`"ok`":true}") } catch { }
            try { [Console]::Error.WriteLine('PTY_CONTROL: close-requested') } catch { }
            $state.closeRequested = $true
            # Bounded teardown: terminating the child unblocks the
            # main thread's wait, which then runs the normal cleanup
            # and exits. Waiting indefinitely for a child that never
            # exits after its console is closed would reintroduce the
            # unbounded-hang class the Q1 cleanup exists to remove,
            # so close terminates rather than waiting. Node only
            # sends close while tearing down (cancel), never on a
            # healthy session's behalf.
            try { [void][OcwConPty]::TerminateProcess($procHandle, 1) } catch { }
            break
          } else {
            try { $writer.WriteLine("{`"id`":$idJson,`"ok`":false,`"error`":`"PTY_CONTROL_INVALID`"}" ) } catch { break }
          }
        }
      } catch {
        # WaitForConnection / stream failure: fall through to the
        # abandonment check below.
      } finally {
        # Pipe disconnect while the child is still running is session
        # abandonment: an orphaned ConPTY child with no owner must not
        # outlive its session. TerminateProcess on an already-exited
        # child fails harmlessly, so the STILL_ACTIVE (259) gate only
        # keeps the stage line honest.
        try {
          [uint32]$code = 0
          if ([OcwConPty]::GetExitCodeProcess($procHandle, [ref]$code) -and $code -eq 259) {
            [void][OcwConPty]::TerminateProcess($procHandle, 1)
            # A close-requested teardown already logged its own stage
            # line; only a genuine disconnect earns 'abandoned'.
            if (-not $state.closeRequested) {
              try { [Console]::Error.WriteLine('PTY_CONTROL: abandoned') } catch { }
            }
          }
        } catch { }
        try { $server.Disconnect() } catch { }
        try { $server.Dispose() } catch { }
      }
    }).AddParameters(@{ server = $controlServer; hPC = $hPC; procHandle = $procInfo.hProcess; state = $controlState })
    $controlJob = $controlPump.BeginInvoke()
  }

  # Host ends are owned by exactly one FileStream each
  # (ownsHandle=$true): FileStream.Close then really closes the
  # underlying handle. With $false the cleanup below could not rely on
  # Close to release anything, and a second owner could keep the pipe
  # open past EOF. The ConPTY-side ends are not wrapped here at all.
  $outputStream = New-Object System.IO.FileStream((New-Object Microsoft.Win32.SafeHandles.SafeFileHandle($outputPipe.Read, $true)), [System.IO.FileAccess]::Read)
  $inputStream = New-Object System.IO.FileStream((New-Object Microsoft.Win32.SafeHandles.SafeFileHandle($inputPipe.Write, $true)), [System.IO.FileAccess]::Write)
  $consoleOut = [Console]::OpenStandardOutput()
  $consoleIn = [Console]::OpenStandardInput()

  # Readiness line, flushed BEFORE the output pump starts, so it is
  # strictly the first stdout line and the provider can strip exactly
  # this line. It is written through $consoleOut -- the SAME stream
  # object the output pump writes through -- not through
  # [Console]::Out, which is a separate TextWriter over the same
  # handle: two writers can reorder bytes across their independent
  # buffers, letting child output beat READY to the provider (the
  # first Windows CI run's readiness failures). One stream means
  # READY-then-pump order is strict by construction. The provider
  # accepts READY modulo a trailing CR. No READY in the legacy path.
  if ($null -ne $controlServer) {
    $readyBytes = [System.Text.Encoding]::ASCII.GetBytes("READY`r`n")
    $consoleOut.Write($readyBytes, 0, $readyBytes.Length)
    $consoleOut.Flush()
  }

  # Pump diagnostics, shared with both runspaces. The input pump used
  # to swallow every exception silently, so a stuck or failed input
  # path was indistinguishable from a child that never read input.
  $pumpStats = [hashtable]::Synchronized(@{
    stop = $false
    inputRead = 0; inputWritten = 0; inputError = ''
    outputRead = 0; outputWritten = 0; outputError = ''
  })
  $outputPump = [powershell]::Create().AddScript({
    param($from, $to, $stats)
    $buffer = New-Object byte[] 65536
    try {
      while ($true) {
        $n = $from.Read($buffer, 0, $buffer.Length)
        if ($n -le 0) { break }
        $stats.outputRead += $n
        $to.Write($buffer, 0, $n)
        $to.Flush()
        $stats.outputWritten += $n
      }
    } catch {
      $stats.outputError = $_.Exception.GetType().FullName
      [Console]::Error.WriteLine("PTY_OUTPUT_PUMP_ERROR: class=$($stats.outputError)")
    }
  }).AddParameters(@{ from = $outputStream; to = $consoleOut; stats = $pumpStats })
  $inputPump = [powershell]::Create().AddScript({
    param($from, $to, $stats)
    $buffer = New-Object byte[] 65536
    try {
      while (-not $stats.stop) {
        $n = $from.Read($buffer, 0, $buffer.Length)
        if ($n -le 0) { break }
        $stats.inputRead += $n
        $to.Write($buffer, 0, $n)
        $to.Flush()
        $stats.inputWritten += $n
      }
    } catch {
      $stats.inputError = $_.Exception.GetType().FullName
      [Console]::Error.WriteLine("PTY_INPUT_PUMP_ERROR: class=$($stats.inputError)")
    }
  }).AddParameters(@{ from = $consoleIn; to = $inputStream; stats = $pumpStats })
  $outputJob = $outputPump.BeginInvoke()
  $inputJob = $inputPump.BeginInvoke()
  try {
    [Console]::Error.WriteLine('PTY_STAGE: before-wait')
    $waitResult = [OcwConPty]::WaitForSingleObject($procInfo.hProcess, [OcwConPty]::WaitInfinite)
    # The Wait return value used to be discarded with [void]; a
    # timeout or failure there is exactly the difference between "the
    # child never exited" and "the child exited but cleanup hung", so
    # it is logged, not dropped. WAIT_OBJECT_0 = 0, WAIT_TIMEOUT = 258.
    [Console]::Error.WriteLine(('PTY_WAIT: result={0}; hex=0x{0:X8}' -f $waitResult))
    # Read the code as [uint32]: GetExitCodeProcess returns a DWORD,
    # and a child NTSTATUS (>= 2^31) must survive the read instead of
    # crashing an [int] cast. The raw code is reported on stderr
    # BEFORE entering the finally block below, so a later cleanup
    # failure cannot be mistaken for the child's own exit code; the
    # provider carries it as error.childExitCode (only when received)
    # while the helper's own exit stays normalized to 0/1.
    [uint32]$exitCode = 0
    if (-not [OcwConPty]::GetExitCodeProcess($procInfo.hProcess, [ref]$exitCode)) { throw 'GetExitCodeProcess failed' }
    [Console]::Error.WriteLine(('PTY_CHILD_EXIT: decimal={0}; hex=0x{0:X8}' -f $exitCode))
  } finally {
    [Console]::Error.WriteLine('PTY_STAGE: entering-cleanup')
    # Cleanup order is "release the real I/O, bounded-wait, Dispose"
    # -- NOT the previous "close streams, then synchronously Stop".
    # Closing a pump's WRITE target does not unblock a synchronous
    # Read on its source, and a synchronous Stop() on a pump blocked
    # in Read can itself block forever, which is a live candidate for
    # the 60s helper hang. So: signal the input pump, attempt to
    # cancel its blocked stdin Read (CancelIoEx; best effort -- it
    # only cancels I/O issued by the calling thread, so a FALSE here
    # is informative, not fatal), close the stdin stream, then keep
    # the OUTPUT pump running while ClosePseudoConsole runs (closing
    # the console can emit a final frame, and on older Windows it can
    # stall if the output pipe is neither closed nor being read).
    # Each pump is then awaited only for a bounded time; a pump that
    # is still blocked after that is NOT Stop()ed synchronously --
    # its Dispose is skipped and logged, and process exit below
    # terminates it. Hiding a stuck pump behind an unbounded Stop
    # would reproduce the hang this change exists to remove.
    try { $pumpStats.stop = $true } catch { }
    $stdinHandle = [IntPtr]::Zero
    try {
      if ($consoleIn -is [System.IO.FileStream]) { $stdinHandle = $consoleIn.SafeFileHandle.DangerousGetHandle() }
    } catch { }
    $cancelOk = $false
    if ($stdinHandle -ne [IntPtr]::Zero) {
      try { $cancelOk = [OcwConPty]::CancelIoEx($stdinHandle, [IntPtr]::Zero) } catch { $cancelOk = $false }
    }
    [Console]::Error.WriteLine("PTY_STAGE: cancel-input-read ok=$cancelOk")
    try { $consoleIn.Close() } catch { }
    try { $inputStream.Close() } catch { }
    try { [OcwConPty]::ClosePseudoConsole($hPC) } catch { }
    [Console]::Error.WriteLine('PTY_STAGE: conpty-closed')
    $outputDone = $false
    try { $outputDone = $outputJob.AsyncWaitHandle.WaitOne(5000) } catch { }
    [Console]::Error.WriteLine("PTY_STAGE: output-pump-done=$outputDone")
    if ($outputDone) { try { $outputPump.EndInvoke($outputJob) } catch { } }
    try { $outputStream.Close() } catch { }
    $inputDone = $false
    try { $inputDone = $inputJob.AsyncWaitHandle.WaitOne(2000) } catch { }
    [Console]::Error.WriteLine("PTY_STAGE: input-pump-done=$inputDone")
    if ($inputDone) { try { $inputPump.EndInvoke($inputJob) } catch { } }
    if ($outputDone) { try { $outputPump.Dispose() } catch { } } else { [Console]::Error.WriteLine('PTY_STAGE: output-pump-dispose-skipped-still-running') }
    if ($inputDone) { try { $inputPump.Dispose() } catch { } } else { [Console]::Error.WriteLine('PTY_STAGE: input-pump-dispose-skipped-still-running') }
    # Control pump: NEVER waited on (it blocks on the pipe while Node
    # holds it open, and Node only closes the pipe after the helper
    # exits -- waiting here would deadlock). A zero-time check only:
    # EndInvoke + Dispose when already finished, otherwise skip and
    # let process exit terminate it, exactly like a stuck I/O pump.
    $controlDone = $false
    try { if ($null -ne $controlJob) { $controlDone = $controlJob.AsyncWaitHandle.WaitOne(0) } } catch { }
    [Console]::Error.WriteLine("PTY_STAGE: control-pump-done=$controlDone")
    if ($controlDone) { try { $controlPump.EndInvoke($controlJob) } catch { } try { $controlPump.Dispose() } catch { } } elseif ($null -ne $controlPump) { [Console]::Error.WriteLine('PTY_STAGE: control-pump-dispose-skipped-still-running') }
    try { if ($null -ne $controlServer) { $controlServer.Dispose() } } catch { }
    [void][OcwConPty]::CloseHandle($procInfo.hProcess)
    # ConPTY-side ends were already closed (and zeroed) right after a
    # successful CreateProcess; close them here only if that step did
    # not run (CreateProcess failure path), never twice.
    if ($inputPipe.Read -ne [IntPtr]::Zero) { [void][OcwConPty]::CloseHandle($inputPipe.Read); $inputPipe.Read = [IntPtr]::Zero }
    if ($outputPipe.Write -ne [IntPtr]::Zero) { [void][OcwConPty]::CloseHandle($outputPipe.Write); $outputPipe.Write = [IntPtr]::Zero }
    [Console]::Error.WriteLine(('PTY_PUMP_STATS: inputRead={0}; inputWritten={1}; inputError={2}; outputRead={3}; outputWritten={4}; outputError={5}' -f $pumpStats.inputRead, $pumpStats.inputWritten, $pumpStats.inputError, $pumpStats.outputRead, $pumpStats.outputWritten, $pumpStats.outputError))
  }
  # GetExitCodeProcess returns a DWORD; a child exit code >= 2^31 is an
  # NTSTATUS value, and PowerShell's [int] cast of such a uint throws
  # ("too large or too small for an Int32") instead of wrapping -- so
  # a child exiting with e.g. 0xC0000002 crashed the helper at this
  # line instead of reporting failure. The provider only distinguishes
  # zero from non-zero (the numeric code is not carried on the failed
  # result, a known gap shared with the POSIX provider), so normalize
  # here: 0 stays 0, anything else becomes 1. Behavior is identical
  # for all codes except >= 2^31, where it replaces a helper crash
  # with the failure the provider would have reported anyway.
  if ($exitCode -eq 0) { [Environment]::Exit(0) } else { [Environment]::Exit(1) }
} catch {
  [Console]::Error.WriteLine("PTY_FAILED: $($_.Exception.Message)")
  [Environment]::Exit(1)
}
