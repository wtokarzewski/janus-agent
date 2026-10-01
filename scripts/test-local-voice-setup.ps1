# End-to-end installer orchestration with a disposable Git repository and fake app.
param([Parameter(Mandatory=$true)][string]$ToolsDirectory)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$source = $PSScriptRoot
$root = Join-Path ([IO.Path]::GetTempPath()) ('janus setup ' + [guid]::NewGuid().ToString('N'))
$remote = Join-Path $root 'remote.git'
$repo = Join-Path $root 'checkout'
$bootstrap = Join-Path $root 'setup.ps1'
$taskName = 'Janus setup test ' + [guid]::NewGuid().ToString('N')
$utf8 = New-Object Text.UTF8Encoding($false)
New-Item -ItemType Directory -Path $repo -Force | Out-Null
Copy-Item (Join-Path $source 'setup-local-voice.ps1') $bootstrap
$hash = [Security.Cryptography.SHA256]::Create()
try { $key = [BitConverter]::ToString($hash.ComputeHash($utf8.GetBytes($repo.ToLowerInvariant()))).Replace('-', '').Substring(0, 16) }
finally { $hash.Dispose() }
$stateDirectory = Join-Path $env:LOCALAPPDATA "Janus\voice-setup\$key"
$gateway = $null
$folder = $null
function Run([string]$Command, [string[]]$Arguments) {
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Command failed: $LASTEXITCODE" }
}
function Assert([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Setup([switch]$RestoreTrial, [switch]$ExpectFailure) {
    $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $bootstrap, '-RepositoryPath', $repo, '-ToolsDirectory', $ToolsDirectory, '-TaskName', $taskName, '-NoStart')
    if ($RestoreTrial) { $arguments += '-Restore' }
    & powershell.exe @arguments
    if ($ExpectFailure) {
        Assert ($LASTEXITCODE -ne 0) 'Expected installation failure'
        # The Actions PowerShell wrapper propagates LASTEXITCODE after this script.
        # An asserted failure is a successful test, not a failing workflow step.
        $global:LASTEXITCODE = 0
    }
    else { Assert ($LASTEXITCODE -eq 0) 'Installer failed' }
}
Push-Location $repo
try {
    Run 'git' @('init', '--bare', $remote)
    Run 'git' @('init', '-b', 'main')
    Run 'git' @('config', 'user.name', 'Setup Test')
    Run 'git' @('config', 'user.email', 'setup-test@example.invalid')
    [IO.File]::WriteAllText((Join-Path $repo '.gitignore'), "janus.json`n.janus/`nnode_modules/`n.fail`n", $utf8)
    $package = '{"name":"setup-fixture","version":"1.0.0","scripts":{"typecheck":"node check.cjs","test:voice":"node check.cjs","start":"node check.cjs"}}'
    [IO.File]::WriteAllText((Join-Path $repo 'package.json'), $package, $utf8)
    [IO.File]::WriteAllText((Join-Path $repo 'check.cjs'), 'if(require("fs").existsSync(".fail") && process.argv.includes("voice-check")) process.exit(9);', $utf8)
    Run 'npm.cmd' @('install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund')
    Run 'git' @('add', '.')
    Run 'git' @('commit', '-m', 'Fixture base')
    Run 'git' @('remote', 'add', 'origin', $remote)
    Run 'git' @('push', '-u', 'origin', 'main')
    Run 'git' @('switch', '-c', 'feature/local-voice')
    New-Item -ItemType Directory (Join-Path $repo 'scripts') | Out-Null
    foreach ($name in @('setup-local-voice.ps1', 'install-local-voice.ps1', 'local-voice-config.mjs')) { Copy-Item (Join-Path $source $name) (Join-Path $repo 'scripts') }
    Run 'git' @('add', '.')
    Run 'git' @('commit', '-m', 'Fixture feature')
    Run 'git' @('push', '-u', 'origin', 'feature/local-voice')
    Run 'git' @('switch', 'main')
    # Exercise DWIM branch creation, not only switching an existing local branch.
    Run 'git' @('branch', '-D', 'feature/local-voice')
    $original = '{"llm":{"apiKey":"fixture-secret"},"voice":{"enabled":false},"autoUpdate":{"enabled":true}}'
    [IO.File]::WriteAllText((Join-Path $repo 'janus.json'), $original, $utf8)
    $service = New-Object -ComObject 'Schedule.Service'
    $service.Connect()
    $folder = $service.GetFolder('\')
    $definition = $service.NewTask(0)
    $definition.Settings.Enabled = $true
    $action = $definition.Actions.Create(0)
    $action.Path = $env:ComSpec
    $action.Arguments = '/c exit 0'
    $action.WorkingDirectory = $repo
    $folder.RegisterTaskDefinition($taskName, $definition, 6, $null, $null, 3) | Out-Null
    # A real Node process identified only through the application's PID file.
    New-Item -ItemType Directory (Join-Path $repo '.janus') | Out-Null
    $gatewayScript = Join-Path $root 'gateway.cjs'
    [IO.File]::WriteAllText($gatewayScript, 'require("fs").writeFileSync(process.argv[2],String(process.pid)); setInterval(()=>{},1000);', $utf8)
    $lockPath = Join-Path $repo '.janus\gateway.pid'
    $gateway = Start-Process node -ArgumentList "`"$gatewayScript`" `"$lockPath`"" -PassThru -WindowStyle Hidden
    for ($i=0; $i -lt 50 -and -not (Test-Path $lockPath); $i++) { Start-Sleep -Milliseconds 100 }
    Assert (Test-Path $lockPath) 'Fixture gateway did not start'
    Setup
    $gateway.Refresh()
    Assert $gateway.HasExited 'Original gateway is still running'
    Assert (-not $folder.GetTask($taskName).Enabled) 'Supervisor was not disabled'
    Assert (((Run 'git' @('branch', '--show-current')) | Out-String).Trim() -eq 'feature/local-voice') 'Wrong branch'
    $config = Get-Content janus.json -Raw | ConvertFrom-Json
    Assert ($config.voice.provider -eq 'local' -and $config.llm.apiKey -eq 'fixture-secret' -and -not $config.autoUpdate.enabled) 'Configuration merge failed'
    $backupBefore = Get-Content (Join-Path $stateDirectory 'configuration.json') -Raw
    Setup
    Assert ((Get-Content (Join-Path $stateDirectory 'configuration.json') -Raw) -eq $backupBefore) 'Rerun overwrote original backup'
    Setup -RestoreTrial
    Assert $folder.GetTask($taskName).Enabled 'Supervisor was not restored'
    Assert (((Run 'git' @('branch', '--show-current')) | Out-String).Trim() -eq 'main') 'Original branch not restored'
    $config = Get-Content janus.json -Raw | ConvertFrom-Json
    Assert (-not $config.voice.enabled -and $config.autoUpdate.enabled -and $config.llm.apiKey -eq 'fixture-secret') 'Original settings not restored'
    # Failure after configuration mutation must restore both branch and config.
    [IO.File]::WriteAllText((Join-Path $repo '.fail'), 'fail', $utf8)
    Setup -ExpectFailure
    Assert (((Run 'git' @('branch', '--show-current')) | Out-String).Trim() -eq 'main') 'Failed install left wrong branch'
    $config = Get-Content janus.json -Raw | ConvertFrom-Json
    Assert (-not $config.voice.enabled -and $config.autoUpdate.enabled) 'Failed install did not restore config'
    Assert $folder.GetTask($taskName).Enabled 'Failed install did not restore supervisor'
    Remove-Item -LiteralPath (Join-Path $repo '.fail')
    # Local edits must stop installation before a branch switch or task mutation.
    Add-Content (Join-Path $repo 'check.cjs') '// local change'
    Setup -ExpectFailure
    Assert $folder.GetTask($taskName).Enabled 'Dirty checkout changed supervisor'
    Assert ((Get-Content (Join-Path $repo 'check.cjs') -Raw).Contains('// local change')) 'Local change was overwritten'
    Write-Host 'Installer, repeat install, rollback, failure recovery and dirty checkout checks passed.'
} finally {
    if ($gateway -and -not $gateway.HasExited) { Stop-Process -Id $gateway.Id -Force -ErrorAction SilentlyContinue }
    if ($folder) { try { $folder.DeleteTask($taskName, 0) } catch {} }
    Pop-Location
    Remove-Item -LiteralPath $root -Recurse -Force
    Get-ChildItem -LiteralPath (Split-Path $stateDirectory -Parent) -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -eq $key -or $_.Name.StartsWith("$key-") } |
        Remove-Item -Recurse -Force
}
