param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('msi', 'nsis')]
  [string]$InstallerType,

  [Parameter(Mandatory = $true)]
  [string]$InstallerPath
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

if ($env:GITHUB_ACTIONS -ne 'true') {
  throw 'Installer lifecycle smoke is restricted to an ephemeral GitHub Actions runner.'
}

$installer = Get-Item -LiteralPath $InstallerPath
if (-not $installer.Exists) { throw 'Installer file is unavailable.' }
if ($InstallerType -eq 'msi' -and $installer.Extension -ne '.msi') { throw 'MSI smoke requires an MSI package.' }
if ($InstallerType -eq 'nsis' -and $installer.Extension -ne '.exe') { throw 'NSIS smoke requires an EXE package.' }

$testRoot = Join-Path $env:RUNNER_TEMP ("OpenClaw Workbench installer smoke-{0}" -f [guid]::NewGuid().ToString('N'))
$installRoot = Join-Path $testRoot 'install'
$workspace = Join-Path $testRoot 'workspace'
$workspaceMarker = Join-Path $workspace 'preserve-through-uninstall.txt'
$secretName = "installer-smoke-{0}" -f [guid]::NewGuid().ToString('N')
$secretTarget = "OpenClawWorkbench:openclaw-workbench:$secretName"
$secretValue = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
$controlToken = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
$approvalToken = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
$credentialCreated = $false
$installed = $false
$uninstalled = $false
$runtimeProcess = $null
$desktopProcess = $null
$credentialCleanupFailed = $false
$smokeSucceeded = $false
$msiDiagnosticsPath = Join-Path $env:RUNNER_TEMP 'msi-uninstall.diagnostics.txt'

if (-not ('OpenClawInstallerSmokeCredential' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OpenClawInstallerSmokeCredential {
  [DllImport("Advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredRead(string target, UInt32 type, UInt32 flags, out IntPtr credential);
  [DllImport("Advapi32.dll", EntryPoint="CredDeleteW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredDelete(string target, UInt32 type, UInt32 flags);
  [DllImport("Advapi32.dll")]
  public static extern void CredFree(IntPtr credential);
}
'@
}

function Test-CredentialTarget([string]$Target) {
  $pointer = [IntPtr]::Zero
  if (-not [OpenClawInstallerSmokeCredential]::CredRead($Target, 1, 0, [ref]$pointer)) { return $false }
  [OpenClawInstallerSmokeCredential]::CredFree($pointer)
  return $true
}

function Get-InstalledProductEntries {
  $uninstallRoots = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
  )
  foreach ($root in $uninstallRoots) {
    Get-ItemProperty -Path $root -ErrorAction SilentlyContinue |
      Where-Object { $_.DisplayName -eq 'OpenClaw Workbench' }
  }
}

function Get-InstalledDesktopExecutable([string]$Root) {
  $candidates = @(Get-ChildItem -LiteralPath $Root -File -Filter '*.exe' |
    Where-Object { $_.Name -notmatch '^un(?:inst|ins|install)|^node(?:[-.]|$)' })
  if ($candidates.Count -ne 1) { throw 'Installed desktop application executable could not be identified unambiguously.' }
  return $candidates[0].FullName
}

function Get-MsiProductCode([string]$Path) {
  $windowsInstaller = New-Object -ComObject WindowsInstaller.Installer
  $database = $windowsInstaller.OpenDatabase($Path, 0)
  $view = $database.OpenView('SELECT `Value` FROM `Property` WHERE `Property` = ''ProductCode''')
  try {
    $view.Execute()
    $record = $view.Fetch()
    if (-not $record) { throw 'MSI ProductCode is missing.' }
    return $record.StringData(1)
  } finally {
    if ($record) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($record) }
    [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($view)
    [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($database)
    [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($windowsInstaller)
  }
}

function Write-MsiTimeoutDiagnostics([string]$Path, [int]$TimedOutProcessId) {
  try {
    $lines = [System.Collections.Generic.List[string]]::new()
    $lines.Add("Captured at $([DateTime]::UtcNow.ToString('O'))")
    $lines.Add("--- msiexec processes (timed-out process id: $TimedOutProcessId) ---")
    Get-CimInstance Win32_Process -Filter "Name = 'msiexec.exe'" -ErrorAction SilentlyContinue |
      Select-Object ProcessId, ParentProcessId, CommandLine, ExecutablePath |
      Format-List | Out-String | ForEach-Object { $lines.Add($_.TrimEnd()) }
    $lines.Add('--- Windows Installer service ---')
    Get-Service -Name msiserver -ErrorAction SilentlyContinue |
      Select-Object Name, Status, StartType |
      Format-List | Out-String | ForEach-Object { $lines.Add($_.TrimEnd()) }
    $lines.Add('--- recent MsiInstaller events ---')
    Get-WinEvent -FilterHashtable @{ LogName = 'Application'; ProviderName = 'MsiInstaller'; StartTime = (Get-Date).AddMinutes(-15) } -MaxEvents 50 -ErrorAction SilentlyContinue |
      Select-Object TimeCreated, Id, LevelDisplayName, Message |
      Format-List | Out-String | ForEach-Object { $lines.Add($_.TrimEnd()) }
    $lines.Add('--- current MSI verbose log tail ---')
    if (Test-Path -LiteralPath (Join-Path $env:RUNNER_TEMP 'msi-uninstall.log') -PathType Leaf) {
      Get-Content -LiteralPath (Join-Path $env:RUNNER_TEMP 'msi-uninstall.log') -Tail 40 | ForEach-Object { $lines.Add($_) }
    }
    Set-Content -LiteralPath $Path -Value $lines
  } catch {
    Set-Content -LiteralPath $Path -Value "Diagnostic collection failed: $($_.Exception.Message)"
  }
}

function Invoke-InstallerProcess([string]$FilePath, [string[]]$Arguments, [string]$Operation, [AllowNull()][string]$RawArguments = $null, [int]$TimeoutSeconds = 180, [AllowNull()][string]$FailureLogPath = $null) {
  $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $FilePath
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  if ($null -ne $RawArguments) {
    $startInfo.Arguments = $RawArguments
  } else {
    foreach ($argument in $Arguments) { [void]$startInfo.ArgumentList.Add($argument) }
  }

  $process = $null
  try {
    $process = [System.Diagnostics.Process]::Start($startInfo)
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
      if ($Operation -eq 'msi uninstall') {
        Write-MsiTimeoutDiagnostics $msiDiagnosticsPath $process.Id
      }
      $process.Kill($true)
      [void]$process.WaitForExit(10000)
      if ($FailureLogPath -and (Test-Path -LiteralPath $FailureLogPath -PathType Leaf)) {
        throw "$Operation timed out; diagnostic log retained at: $FailureLogPath"
      }
      throw "$Operation timed out."
    }
    return $process.ExitCode
  } finally {
    if ($process) { $process.Dispose() }
  }
}

function Invoke-InstallerInstall {
  if (Test-Path -LiteralPath $installRoot) { throw 'Smoke install directory unexpectedly exists.' }
  if ($InstallerType -eq 'msi') {
    $rawArguments = "/i `"$($installer.FullName)`" /qn /norestart INSTALLDIR=`"$installRoot`""
    $exitCode = Invoke-InstallerProcess -FilePath 'msiexec.exe' -Arguments @() -RawArguments $rawArguments -Operation "$InstallerType install"
  } else {
    $exitCode = Invoke-InstallerProcess -FilePath $installer.FullName -Arguments @() -RawArguments "/S /D=$installRoot" -Operation "$InstallerType install"
  }
  if ($exitCode -ne 0) { throw "$InstallerType installer exited with code $exitCode." }
  if (-not (Test-Path -LiteralPath $installRoot -PathType Container)) { throw "$InstallerType installer did not create the requested install directory." }
}

function Invoke-InstallerUninstall {
  if ($InstallerType -eq 'msi') {
    $productCode = Get-MsiProductCode $installer.FullName
    $logPath = Join-Path $env:RUNNER_TEMP 'msi-uninstall.log'
    Set-Content -LiteralPath $logPath -Value "Starting MSI uninstall for product $productCode at $([DateTime]::UtcNow.ToString('O'))." -NoNewline
    $rawArguments = "/x `"$productCode`" /qn /norestart /L*V!+ `"$logPath`""
    $exitCode = Invoke-InstallerProcess -FilePath 'msiexec.exe' -Arguments @() -RawArguments $rawArguments -Operation "$InstallerType uninstall" -TimeoutSeconds 600 -FailureLogPath $logPath
  } else {
    $uninstaller = Get-ChildItem -LiteralPath $installRoot -File -Filter '*.exe' -Recurse |
      Where-Object { $_.Name -match '^un(?:inst|ins|install).*\.exe$' } |
      Select-Object -First 1
    if (-not $uninstaller) { throw 'NSIS uninstaller executable was not found.' }
    $exitCode = Invoke-InstallerProcess -FilePath $uninstaller.FullName -Arguments @('/S') -Operation "$InstallerType uninstall"
  }
  if ($exitCode -ne 0) { throw "$InstallerType uninstaller exited with code $exitCode." }
  if (Test-Path -LiteralPath $desktopExecutable) { throw "$InstallerType uninstall left the application executable behind." }
  if (Test-Path -LiteralPath (Join-Path $installRoot 'runtime\node\node.exe')) { throw "$InstallerType uninstall left the bundled Node runtime behind." }
  if (Test-Path -LiteralPath (Join-Path $installRoot 'runtime\bin\workbench.mjs')) { throw "$InstallerType uninstall left the bundled Runtime behind." }
  if (Get-InstalledProductEntries) { throw "$InstallerType uninstall left an installed-product registration behind." }
}

try {
  New-Item -ItemType Directory -Path $workspace -Force | Out-Null
  Set-Content -LiteralPath $workspaceMarker -Value 'Preserve this disposable workspace through uninstall.' -NoNewline

  Invoke-InstallerInstall
  $installed = $true
  if (-not (Get-InstalledProductEntries)) { throw "$InstallerType install did not register the product." }

  $desktopExecutable = Get-InstalledDesktopExecutable $installRoot
  $nodeExecutable = Join-Path $installRoot 'runtime\node\node.exe'
  $runtimeScript = Join-Path $installRoot 'runtime\bin\workbench.mjs'
  if (-not (Test-Path -LiteralPath $nodeExecutable -PathType Leaf)) { throw 'Installed bundled Node runtime is missing.' }
  if (-not (Test-Path -LiteralPath $runtimeScript -PathType Leaf)) { throw 'Installed Runtime entry point is missing.' }

  $desktopProcess = Start-Process -FilePath $desktopExecutable -WorkingDirectory $installRoot -WindowStyle Hidden -PassThru
  Start-Sleep -Seconds 3
  if ($desktopProcess.HasExited) { throw 'Installed desktop application exited during startup.' }
  $desktopProcess.Kill($true)
  if (-not $desktopProcess.WaitForExit(10000)) { throw 'Installed desktop application did not stop after the smoke check.' }
  $desktopProcess = $null

  $runtimeStart = [System.Diagnostics.ProcessStartInfo]::new()
  $runtimeStart.FileName = $nodeExecutable
  $runtimeStart.WorkingDirectory = $workspace
  $runtimeStart.UseShellExecute = $false
  $runtimeStart.CreateNoWindow = $true
  $runtimeStart.RedirectStandardOutput = $true
  $runtimeStart.RedirectStandardError = $true
  foreach ($argument in @($runtimeScript, '--root', $workspace, '--host', '127.0.0.1', '--port', '0', '--token-env', 'OPENCLAW_INSTALLER_SMOKE_TOKEN', '--approval-token-env', 'OPENCLAW_INSTALLER_SMOKE_APPROVAL', '--json')) {
    [void]$runtimeStart.ArgumentList.Add($argument)
  }
  $runtimeStart.Environment['OPENCLAW_INSTALLER_SMOKE_TOKEN'] = $controlToken
  $runtimeStart.Environment['OPENCLAW_INSTALLER_SMOKE_APPROVAL'] = $approvalToken
  $runtimeProcess = [System.Diagnostics.Process]::new()
  $runtimeProcess.StartInfo = $runtimeStart
  if (-not $runtimeProcess.Start()) { throw 'Bundled Runtime process did not start.' }
  $readyLine = $runtimeProcess.StandardOutput.ReadLineAsync()
  if (-not $readyLine.Wait(20000)) { throw 'Bundled Runtime did not become ready within the smoke timeout.' }
  $ready = $readyLine.GetAwaiter().GetResult() | ConvertFrom-Json
  if ($ready.service.host -ne '127.0.0.1' -or $ready.service.port -lt 1) { throw 'Bundled Runtime returned an invalid loopback address.' }
  $baseUrl = "http://127.0.0.1:$($ready.service.port)"
  $headers = @{ Authorization = "Bearer $controlToken" }
  $health = Invoke-RestMethod -Uri "$baseUrl/health" -Headers $headers -TimeoutSec 5
  if ($health.ok -ne $true -or $health.service -ne 'openclaw-workbench') { throw 'Bundled Runtime health check failed.' }

  $secretPayload = @{ name = $secretName; value = $secretValue } | ConvertTo-Json -Compress
  $secretResponse = Invoke-RestMethod -Uri "$baseUrl/v1/secrets" -Method Post -Headers $headers -ContentType 'application/json' -Body $secretPayload -TimeoutSec 5
  if ($secretResponse.configured -ne $true -or $secretResponse.name -ne $secretName) { throw 'Credential Manager smoke setup failed.' }
  $credentialCreated = Test-CredentialTarget $secretTarget
  if (-not $credentialCreated) { throw 'Runtime did not create the isolated Credential Manager entry.' }

  $shutdown = Invoke-RestMethod -Uri "$baseUrl/v1/shutdown" -Method Post -Headers $headers -TimeoutSec 5
  if ($shutdown.accepted -ne $true) { throw 'Bundled Runtime shutdown was not accepted.' }
  if (-not $runtimeProcess.WaitForExit(10000)) { throw 'Bundled Runtime did not stop after the smoke check.' }
  $runtimeProcess.Dispose()
  $runtimeProcess = $null

  Invoke-InstallerUninstall
  $uninstalled = $true
  if (-not (Test-Path -LiteralPath $workspaceMarker -PathType Leaf)) { throw "$InstallerType uninstall removed the selected workspace." }
  if (-not (Test-CredentialTarget $secretTarget)) { throw "$InstallerType uninstall removed user Credential Manager data." }

  $smokeSucceeded = $true
  Write-Output "$InstallerType installer smoke passed: install, app launch, bundled Runtime health, Credential Manager preservation, and uninstall."
} finally {
  if ($runtimeProcess) {
    try {
      if (-not $runtimeProcess.HasExited) { $runtimeProcess.Kill($true); [void]$runtimeProcess.WaitForExit(10000) }
    } catch { }
    $runtimeProcess.Dispose()
  }
  if ($desktopProcess) {
    try {
      if (-not $desktopProcess.HasExited) { $desktopProcess.Kill($true); [void]$desktopProcess.WaitForExit(10000) }
    } catch { }
    $desktopProcess.Dispose()
  }
  if ($credentialCreated -or (Test-CredentialTarget $secretTarget)) {
    $deleted = [OpenClawInstallerSmokeCredential]::CredDelete($secretTarget, 1, 0)
    if (-not $deleted -and [Runtime.InteropServices.Marshal]::GetLastWin32Error() -ne 1168) {
      $credentialCleanupFailed = $true
    }
  }
  if ($smokeSucceeded -and (Test-Path -LiteralPath $testRoot)) {
    Remove-Item -LiteralPath $testRoot -Recurse -Force
  } elseif (Test-Path -LiteralPath $workspace) {
    Remove-Item -LiteralPath $workspace -Recurse -Force
  }
  if ($installed -and -not $uninstalled) {
    Write-Warning 'Installer cleanup did not complete; the ephemeral runner will be discarded after the job.'
  }
  if ($credentialCleanupFailed -and $smokeSucceeded) { throw 'The disposable Credential Manager entry could not be removed; failing the installer smoke.' }
  if ($credentialCleanupFailed) { Write-Warning 'The disposable Credential Manager entry could not be removed on the failed smoke run.' }
}
