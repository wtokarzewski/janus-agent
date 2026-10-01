# Run as the Windows user who normally runs Janus. No elevation is required.
param(
    [string]$RepositoryPath = 'C:\janus-agent',
    [string]$ToolsDirectory = (Join-Path $env:LOCALAPPDATA 'Janus\voice'),
    [string]$TaskName = 'Janus Gateway',
    [switch]$Restore,
    [switch]$SkipTests,
    [switch]$NoStart
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$RepositoryPath = [IO.Path]::GetFullPath($RepositoryPath).TrimEnd('\', '/')
$ToolsDirectory = [IO.Path]::GetFullPath($ToolsDirectory)
$branch = 'feature/local-voice'
$utf8 = New-Object Text.UTF8Encoding($false)
$hash = [Security.Cryptography.SHA256]::Create()
try { $key = [BitConverter]::ToString($hash.ComputeHash($utf8.GetBytes($RepositoryPath.ToLowerInvariant()))).Replace('-', '').Substring(0, 16) }
finally { $hash.Dispose() }
$stateDirectory = Join-Path $env:LOCALAPPDATA "Janus\voice-setup\$key"
$stateFile = Join-Path $stateDirectory 'setup.json'
$helper = Join-Path $stateDirectory 'local-voice-config.mjs'
$recoveryScript = Join-Path $stateDirectory 'setup-local-voice.ps1'
$state = $null
$task = $null

function Invoke-Checked([string]$Command, [string[]]$Arguments) {
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Command failed (exit $LASTEXITCODE)." }
}
function Save-State {
    $temporary = "$stateFile.tmp"
    [IO.File]::WriteAllText($temporary, ($script:state | ConvertTo-Json -Depth 8), $utf8)
    Move-Item -LiteralPath $temporary -Destination $stateFile -Force
}
function Get-JanusTask([string]$Name) {
    # Task Scheduler COM also works on machines with a broken WMI repository.
    $scheduler = New-Object -ComObject 'Schedule.Service'
    $scheduler.Connect()
    $folder = $scheduler.GetFolder('\')
    $found = @($folder.GetTasks(1) | Where-Object { $_.Name -eq $Name })
    if ($found.Count -eq 0) { return $null }
    $candidate = $found[0]
    $matchesRepo = $false
    foreach ($action in $candidate.Definition.Actions) {
        if ($action.Type -eq 0) {
            $working = [string]$action.WorkingDirectory
            if ($working -and [IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($working)).TrimEnd('\', '/') -eq $RepositoryPath) { $matchesRepo = $true }
        }
    }
    if (-not $matchesRepo) { throw "Task '$Name' does not have this repository as its working directory. No process was stopped." }
    return $candidate
}
function Initialize-ProcessStop {
    if ('JanusVoiceProcessTree' -as [type]) { return }
    # Tool Help enumerates parent/child relationships without WMI or taskkill.
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class JanusVoiceProcessTree {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct Entry {
        public uint size, usage, id;
        public UIntPtr heap;
        public uint module, threads, parent;
        public int priority;
        public uint flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string name;
    }
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern SafeFileHandle CreateToolhelp32Snapshot(uint flags, uint id);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32FirstW(SafeFileHandle snapshot, ref Entry entry);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32NextW(SafeFileHandle snapshot, ref Entry entry);
    public static void Stop(int rootId, long lockTime) {
        var targets = new List<Process>();
        try {
            Process root;
            try { root = Process.GetProcessById(rootId); }
            catch (ArgumentException) { return; }
            targets.Add(root);
            // Retain handles so PID reuse cannot redirect termination to another process.
            IntPtr rootHandle = root.Handle;
            if (!String.Equals(root.ProcessName, "node", StringComparison.OrdinalIgnoreCase)
                || root.StartTime.ToUniversalTime().Ticks > lockTime)
                throw new InvalidOperationException("Gateway PID identity changed; no process was stopped.");
            var entries = new List<Entry>();
            using (var snapshot = CreateToolhelp32Snapshot(2, 0)) {
                if (snapshot.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
                var entry = new Entry { size = (uint)Marshal.SizeOf(typeof(Entry)) };
                bool found = Process32FirstW(snapshot, ref entry);
                while (found) { entries.Add(entry); found = Process32NextW(snapshot, ref entry); }
                int error = Marshal.GetLastWin32Error();
                if (error != 18) throw new Win32Exception(error);
            }
            var seen = new HashSet<int> { rootId };
            for (int i = 0; i < targets.Count; i++) {
                var parent = targets[i];
                foreach (var entry in entries) {
                    if (entry.parent != parent.Id || !seen.Add((int)entry.id)) continue;
                    Process child = null;
                    try {
                        child = Process.GetProcessById((int)entry.id);
                        IntPtr handle = child.Handle;
                        if (child.StartTime.ToUniversalTime() >= parent.StartTime.ToUniversalTime()) {
                            targets.Add(child); child = null;
                        }
                    } catch (ArgumentException) { /* Already exited. */ }
                    catch (InvalidOperationException) { /* Already exited. */ }
                    finally { if (child != null) child.Dispose(); }
                }
            }
            // Stop the gateway first so it cannot launch more workers during cleanup.
            foreach (var target in targets) {
                if (target.HasExited) continue;
                try { target.Kill(); }
                catch (InvalidOperationException) { if (!target.HasExited) throw; }
            }
            foreach (var target in targets)
                if (!target.WaitForExit(15000)) throw new TimeoutException("Gateway worker did not stop.");
        } finally { foreach (var target in targets) target.Dispose(); }
    }
}
'@
}
function Stop-Janus {
    $infoJson = Invoke-Checked 'node' @($helper, 'inspect', $RepositoryPath)
    $info = $infoJson | ConvertFrom-Json
    if (-not (Test-Path -LiteralPath $info.pidFile)) { return }
    $pidFile = Get-Item -LiteralPath $info.pidFile
    $pidText = (Get-Content -LiteralPath $pidFile.FullName -Raw).Trim()
    if ($pidText -notmatch '^[1-9][0-9]*$') { throw 'Invalid gateway PID file; refusing to stop an unidentified process.' }
    $gateway = Get-Process -Id ([int]$pidText) -ErrorAction SilentlyContinue
    if (-not $gateway) { return }
    if ($gateway.ProcessName -ne 'node' -or $gateway.StartTime.ToUniversalTime() -gt $pidFile.LastWriteTimeUtc) {
        throw 'Gateway PID file does not identify an existing Janus Node process safely.'
    }
    Write-Host 'Stopping the current Janus gateway for installation...'
    Initialize-ProcessStop
    [JanusVoiceProcessTree]::Stop($gateway.Id, $pidFile.LastWriteTimeUtc.Ticks)
    # Do not delete the lock: the gateway handles stale PID files itself.
}
function Restore-Trial {
    if ($script:task) { $script:task.Enabled = $false }
    Stop-Janus
    Invoke-Checked 'node' @($helper, 'restore', $RepositoryPath, $stateDirectory)
    $current = (Invoke-Checked 'git' @('rev-parse', 'HEAD') | Out-String).Trim()
    if ($current -ne $script:state.originalCommit -or (Invoke-Checked 'git' @('branch', '--show-current') | Out-String).Trim() -ne $script:state.originalBranch) {
        if ($script:state.originalBranch) { Invoke-Checked 'git' @('switch', $script:state.originalBranch) }
        else { Invoke-Checked 'git' @('switch', '--detach', $script:state.originalCommit) }
    }
    if ($script:state.dependenciesTouched) { Invoke-Checked 'npm.cmd' @('ci') }
    if ($script:task) { $script:task.Enabled = [bool]$script:state.taskEnabled }
    $script:state.phase = 'restored'
    Save-State
    Write-Host 'Previous branch, voice configuration and automatic updates restored.'
}
function Start-Gateway([bool]$Trial) {
    if ($NoStart) { return }
    if (-not $Trial -and $script:task -and $script:state.taskEnabled) {
        $script:task.Run($null) | Out-Null
        Write-Host 'Janus started through its original scheduled task.'
        return
    }
    $previous = $env:JANUS_NO_AUTO_UPDATE
    try {
        if ($Trial) { $env:JANUS_NO_AUTO_UPDATE = '1' }
        Write-Host 'Starting Janus. Keep this window open. Stop it with Ctrl+C.'
        Invoke-Checked 'npm.cmd' @('start', '--', 'gateway')
    } finally { $env:JANUS_NO_AUTO_UPDATE = $previous }
}

Push-Location -LiteralPath $RepositoryPath
try {
    foreach ($command in @('git', 'node', 'npm.cmd')) { Get-Command $command -ErrorAction Stop | Out-Null }
    $nodeVersion = (Invoke-Checked 'node' @('--version') | Out-String).Trim().TrimStart('v')
    $nodeMajor = [int]$nodeVersion.Split('.')[0]
    if ($nodeMajor -lt 22) { throw 'Node.js 22 or newer is required. Existing installation was not changed.' }
    if (-not [Environment]::Is64BitOperatingSystem) { throw '64-bit Windows is required.' }
    $top = (Invoke-Checked 'git' @('rev-parse', '--show-toplevel') | Out-String).Trim()
    if ([IO.Path]::GetFullPath($top).TrimEnd('\', '/') -ne $RepositoryPath) { throw 'RepositoryPath must point to the repository root.' }
    if (Invoke-Checked 'git' @('status', '--porcelain')) { throw 'Repository has local changes. Commit or preserve them before installation; nothing was overwritten.' }
    if (Test-Path -LiteralPath $stateFile) { $state = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json }
    if ($Restore) {
        if (-not $state -or $state.phase -eq 'restored') { Write-Host 'No active voice trial to restore.'; return }
        $task = Get-JanusTask $state.taskName
        Restore-Trial
        Start-Gateway $false
        return
    }
    if ($state -and $state.phase -ne 'restored') {
        if ($state.phase -ne 'ready') {
            Write-Host 'Recovering the interrupted installation before retrying...'
            $task = Get-JanusTask $state.taskName
            Restore-Trial
        }
    }
    if ($state -and $state.phase -eq 'ready') {
        if ((Invoke-Checked 'git' @('branch', '--show-current') | Out-String).Trim() -ne $branch) { throw 'Existing trial is on a different branch. Restore it first.' }
        $task = Get-JanusTask $state.taskName
        if ($task) { $task.Enabled = $false }
        Stop-Janus
        Invoke-Checked 'npm.cmd' @('start', '--', 'voice-check')
        Write-Host 'Voice is already configured; the original backup has been retained.'
        Start-Gateway $true
        return
    }
    Write-Host 'Fetching the voice branch and preparing installation...'
    Invoke-Checked 'git' @('fetch', 'origin', $branch)
    # Cache recovery files outside the checkout before switching branches.
    if ($state) {
        Move-Item -LiteralPath $stateDirectory -Destination ($stateDirectory + '-' + [guid]::NewGuid().ToString('N'))
    }
    New-Item -ItemType Directory -Path $stateDirectory -Force | Out-Null
    foreach ($name in @('local-voice-config.mjs', 'install-local-voice.ps1', 'setup-local-voice.ps1')) {
        $content = Invoke-Checked 'git' @('show', "origin/${branch}:scripts/$name")
        [IO.File]::WriteAllText((Join-Path $stateDirectory $name), (($content -join "`n") + "`n"), $utf8)
    }
    Invoke-Checked 'node' @($helper, 'inspect', $RepositoryPath) | Out-Null
    $task = Get-JanusTask $TaskName
    # Download while the old gateway is still running. Reuse a complete prior tool install.
    if (-not (Test-Path -LiteralPath (Join-Path $ToolsDirectory 'voice-config.json'))) {
        & (Join-Path $stateDirectory 'install-local-voice.ps1') -Directory $ToolsDirectory | Out-Null
    }
    $state = [pscustomobject]@{
        originalBranch = (Invoke-Checked 'git' @('branch', '--show-current') | Out-String).Trim()
        originalCommit = (Invoke-Checked 'git' @('rev-parse', 'HEAD') | Out-String).Trim()
        taskName = $TaskName; taskEnabled = [bool]($task -and $task.Enabled)
        dependenciesTouched = $false; phase = 'installing'
    }
    Save-State
    try {
        if ($task) { $task.Enabled = $false }
        Stop-Janus
        Invoke-Checked 'git' @('switch', $branch)
        Invoke-Checked 'git' @('merge', '--ff-only', "origin/$branch")
        $state.dependenciesTouched = $true
        Save-State
        Invoke-Checked 'npm.cmd' @('ci')
        if (-not $SkipTests) {
            Invoke-Checked 'npm.cmd' @('run', 'typecheck')
            Invoke-Checked 'npm.cmd' @('run', 'test:voice')
        }
        Invoke-Checked 'node' @($helper, 'apply', $RepositoryPath, $stateDirectory, $ToolsDirectory)
        Invoke-Checked 'npm.cmd' @('start', '--', 'voice-check')
        $state.phase = 'ready'
        Save-State
    } catch {
        $failure = $_
        Write-Warning 'Installation failed. Restoring previous configuration and branch...'
        try { Restore-Trial }
        catch { Write-Warning "Automatic recovery incomplete. Run: powershell -ExecutionPolicy Bypass -File `"$recoveryScript`" -RepositoryPath `"$RepositoryPath`" -Restore" }
        throw $failure
    }
    Write-Host 'Local Polish transcription is ready. Send Janus a voice message in Telegram.'
    Write-Host "Backup and rollback script: $stateDirectory"
    Write-Host "Rollback: powershell -ExecutionPolicy Bypass -File `"$recoveryScript`" -RepositoryPath `"$RepositoryPath`" -Restore"
    Start-Gateway $true
} finally { Pop-Location }
