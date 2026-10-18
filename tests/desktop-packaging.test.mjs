import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('Tauri bundle carries the Node runtime as explicit resources', async () => {
  const config = JSON.parse(await readFile(path.join(repoRoot, 'desktop', 'tauri.conf.json'), 'utf8'));
  assert.deepEqual(config.bundle.resources, {
    '../bin': 'runtime/bin',
    '../runtime': 'runtime/runtime',
    '../package.json': 'runtime/package.json',
    'node-runtime': 'runtime/node'
  });
  assert.deepEqual(config.bundle.targets, ['msi', 'nsis']);
});

test('desktop source documents the CI-provided Node runtime without checking in binaries', async () => {
  const placeholder = await readFile(path.join(repoRoot, 'desktop', 'node-runtime', 'README.md'), 'utf8');
  assert.match(placeholder, /v22[.]19[.]0/);
  assert.match(placeholder, /download|CI/i);
  assert.match(placeholder, /not.*commit|binary|out of Git/i);
});

test('Windows bundle includes the required ICO application icon', async () => {
  const icon = await readFile(path.join(repoRoot, 'desktop', 'icons', 'icon.ico'));
  assert.ok(icon.length > 22);
  assert.equal(icon.readUInt16LE(0), 0);
  assert.equal(icon.readUInt16LE(2), 1);
  assert.ok((await stat(path.join(repoRoot, 'desktop', 'icons', 'icon.ico'))).isFile());
});

test('desktop packaging docs distinguish development fallback from release resources', async () => {
  const docs = await readFile(path.join(repoRoot, 'desktop', 'README.md'), 'utf8');
  assert.match(docs, /cargo tauri dev/);
  assert.match(docs, /debug build (?:may use the checkout|first looks for)/);
  assert.match(docs, /compiled out of release builds/);
  assert.match(docs, /runtime\/bin\/workbench\.mjs/);
  assert.match(docs, /instead of falling back to a source checkout/);
});

test('desktop packaging docs provide a non-global Tauri preflight and explain MSVC linker failures', async () => {
  const docs = await readFile(path.join(repoRoot, 'desktop', 'README.md'), 'utf8');
  assert.match(docs, /npx --yes @tauri-apps\/cli@2\.12\.1 info/);
  assert.match(docs, /npx --yes @tauri-apps\/cli@2\.12\.1 build --ci/);
  assert.match(docs, /does not install.*global|without.*global.*install/i);
  assert.match(docs, /link\.exe/);
  assert.match(docs, /Microsoft C\+\+ Build Tools/);
  assert.match(docs, /Windows (?:10|11).*SDK|Windows SDK/i);
});

test('Windows installer lifecycle contract is explicit and version-stable', async () => {
  const config = JSON.parse(await readFile(path.join(repoRoot, 'desktop', 'tauri.conf.json'), 'utf8'));
  const packageJson = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));
  const docs = await readFile(path.join(repoRoot, 'desktop', 'README.md'), 'utf8');

  assert.equal(config.productName, 'OpenClaw Workbench');
  assert.match(config.identifier, /^[a-z0-9]+(?:\.[a-z0-9-]+)+$/);
  assert.equal(config.version, packageJson.version);
  assert.deepEqual(config.bundle.targets, ['msi', 'nsis']);
  assert.equal(config.bundle.active, true);
  assert.match(docs, /install(?:er)? lifecycle/i);
  assert.match(docs, /clean\s+\n?install/i);
  assert.match(docs, /upgrade/i);
  assert.match(docs, /uninstall/i);
  assert.match(docs, /Windows (?:CI|machine|实机)/i);
});

test('installer lifecycle docs keep user data and credentials outside the bundle', async () => {
  const docs = await readFile(path.join(repoRoot, 'desktop', 'README.md'), 'utf8');
  assert.match(docs, /Windows Credential Manager|凭据管理器/i);
  assert.match(docs, /never stores API keys? or runtime bearer tokens in the bundle/i);
  assert.match(docs, /workspace|工作区/);
  assert.match(docs, /uninstall.*(?:workspace|user data)|卸载.*(?:工作区|用户数据)/is);
});

test('Windows CI exercises installed app, bundled runtime, and uninstall for both installer formats', async () => {
  const workflow = await readFile(path.join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
  const smokePath = path.join(repoRoot, 'scripts', 'windows-installer-smoke.ps1');
  const smoke = await readFile(smokePath, 'utf8');

  const smokeStep = workflow.indexOf('Run Windows installer lifecycle smoke');
  const diagnosticsStep = workflow.indexOf('Upload Windows installer smoke diagnostics');
  const uploadStep = workflow.indexOf('Upload Windows installers');
  assert.ok(smokeStep >= 0 && uploadStep > smokeStep, 'installer smoke must pass before artifacts are published');
  assert.ok(diagnosticsStep > smokeStep && uploadStep > diagnosticsStep, 'diagnostics upload must follow installer smoke and precede published installers');
  const smokeWorkflow = workflow.slice(smokeStep, diagnosticsStep);
  assert.match(smokeWorkflow, /\$smokeSucceeded = \$false/);
  assert.match(smokeWorkflow, /try\s*\{[\s\S]*New-Item -ItemType Directory -Path \$packageRoot[\s\S]*finally\s*\{/);
  const packageCopyTry = smokeWorkflow.indexOf('try {');
  const packageCopyFinally = smokeWorkflow.indexOf('} finally {', packageCopyTry);
  const copiedMsi = smokeWorkflow.indexOf('Copy-Item -LiteralPath $msi[0].FullName');
  const copiedNsis = smokeWorkflow.indexOf('Copy-Item -LiteralPath $nsis[0].FullName');
  assert.ok(packageCopyTry >= 0 && packageCopyFinally > packageCopyTry, 'package copy cleanup must have a try/finally boundary');
  assert.ok(copiedMsi > packageCopyTry && copiedMsi < packageCopyFinally, 'MSI copy must be inside the package cleanup boundary');
  assert.ok(copiedNsis > packageCopyTry && copiedNsis < packageCopyFinally, 'NSIS copy must be inside the package cleanup boundary');
  assert.match(workflow, /scripts[\\/]windows-installer-smoke\.ps1/);
  assert.match(workflow, /finally\s*\{[\s\S]*?Remove-Item -LiteralPath \$packageRoot -Recurse -Force/);
  assert.match(smoke, /GITHUB_ACTIONS/);
  assert.match(smoke, /OpenClaw Workbench installer smoke-/i);
  assert.match(smoke, /msiexec\.exe/);
  assert.match(smoke, /\/S/);
  assert.match(smoke, /runtime[\\/]node[\\/]node\.exe/);
  assert.match(smoke, /runtime[\\/]bin[\\/]workbench\.mjs/);
  assert.match(smoke, /\/health/);
  assert.match(smoke, /\/v1\/shutdown/);
  assert.match(smoke, /CredReadW/);
  assert.match(smoke, /CredDeleteW/);
  assert.match(smoke, /\[void\]\$view\.Execute\(\)/);
  assert.match(smoke, /\.ArgumentList\.Add/);
  assert.match(smoke, /RawArguments/);
  assert.match(smoke, /startInfo\.Arguments = \$RawArguments/);
  assert.match(smoke, /INSTALLDIR=`"\$installRoot`"/);
  assert.match(smoke, /"\/S \/D=\$installRoot"/);
  assert.match(smoke, /if \(-not \('OpenClawInstallerSmokeCredential' -as \[type\]\)\)/);
  assert.match(smoke, /function Get-InstalledDesktopExecutable/);
  assert.match(smoke, /un\(\?:inst\|ins\|install\)/);
  assert.match(smoke, /Get-ChildItem -LiteralPath \$installRoot -File -Filter '\*\.exe'/);
  assert.match(smoke, /uninstall left the bundled Node runtime behind/);
  assert.match(smoke, /uninstall left the bundled Runtime behind/);
  assert.match(smoke, /function Invoke-InstallerProcess\([\s\S]*\[int\]\$TimeoutSeconds = 180/);
  assert.match(smoke, /WaitForExit\(\$TimeoutSeconds \* 1000\)/);
  assert.match(smoke, /\$logPath = Join-Path \$env:RUNNER_TEMP 'msi-uninstall\.log'/);
  assert.match(smoke, /Set-Content -LiteralPath \$logPath -Value "Starting MSI uninstall/);
  assert.match(smoke, /\/L\*V!\+/);
  const uninstallStart = smoke.indexOf('function Invoke-InstallerUninstall');
  const msiUninstallStart = smoke.indexOf("if ($InstallerType -eq 'msi') {", uninstallStart);
  const nsisUninstallStart = smoke.indexOf('} else {', msiUninstallStart);
  const msiUninstall = smoke.slice(msiUninstallStart, nsisUninstallStart);
  assert.ok(uninstallStart >= 0 && msiUninstallStart > uninstallStart && nsisUninstallStart > msiUninstallStart, 'MSI uninstall branch must be discoverable');
  assert.match(msiUninstall, /\$rawArguments = "\/x/);
  assert.match(msiUninstall, /-RawArguments \$rawArguments/);
  assert.doesNotMatch(msiUninstall, /-Arguments @\('\/x'/);
  assert.match(smoke, /TimeoutSeconds 600/);
  assert.match(smoke, /FailureLogPath/);
  assert.match(smoke, /Write-MsiTimeoutDiagnostics/);
  assert.match(smoke, /msi-uninstall\.diagnostics\.txt/);
  assert.match(smoke, /Get-CimInstance Win32_Process/);
  assert.match(smoke, /Get-WinEvent/);
  assert.match(smoke, /if \(\$Operation -eq 'msi uninstall'\) \{\s*Write-MsiTimeoutDiagnostics \$msiDiagnosticsPath \$process\.Id\s*\}\s*\$process\.Kill\(\$true\)/);
  assert.match(smoke, /-Operation "\$InstallerType uninstall" -TimeoutSeconds 600 -FailureLogPath \$logPath/);
  assert.match(smoke, /if \(\$smokeSucceeded -and \(Test-Path -LiteralPath \$testRoot\)\)/);
  assert.doesNotMatch(smoke, /if \(\$uninstalled -and \(Test-Path -LiteralPath \$testRoot\)\)/);
  const diagnosticsWorkflow = workflow.slice(diagnosticsStep, uploadStep);
  assert.match(diagnosticsWorkflow, /if:\s*failure\(\)/);
  assert.match(diagnosticsWorkflow, /\$\{\{\s*runner\.temp\s*\}\}\/msi-uninstall\.log/);
  assert.match(diagnosticsWorkflow, /\$\{\{\s*runner\.temp\s*\}\}\/msi-uninstall\.diagnostics\.txt/);
  assert.match(diagnosticsWorkflow, /\$\{\{\s*runner\.temp\s*\}\}\/OpenClaw Workbench installer packages\/\*\.msi/);
  assert.match(smokeWorkflow, /& \$smoke -InstallerType 'nsis' -InstallerPath \$nsisPath\s+\$smokeSucceeded = \$true/);
  assert.match(smokeWorkflow, /if \(\$smokeSucceeded -and \(Test-Path -LiteralPath \$packageRoot\)\)/);
  assert.match(smoke, /installer smoke/);
  assert.match(smoke, /finally/i);
});
