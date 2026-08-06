# Running Janus on Windows across reboots

Janus is a long-running process. Started by hand from a terminal it dies with
that terminal, and a machine that reboots overnight — Windows Update is the
usual culprit — leaves the agent down until somebody notices. Reminders and
cron jobs stop with it.

This sets up a Scheduled Task that starts Janus when you log in and restarts it
if it dies. It is the Windows counterpart of a systemd unit; on Linux, prefer a
systemd user service.

## Register the task

Run in PowerShell, as the user Janus should run as. Set the path first:

```powershell
$JanusPath = 'C:\path\to\janus-agent'   # where you installed Janus

$action = New-ScheduledTaskAction -Execute 'cmd.exe' `
  -Argument "/c cd /d $JanusPath && npm start -- gateway" `
  -WorkingDirectory $JanusPath

$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName 'Janus Gateway' -Action $action `
  -Trigger $trigger -Settings $settings -RunLevel Limited -Force
```

Add your own flags to the `-Argument` line if you use them, e.g.
`npm start -- gateway --token-debug`.

### Why those settings

| Setting | Reason |
|---|---|
| `-RestartCount 999 -RestartInterval 1 minute` | Covers crashes, not just reboots — the task is restarted if the process dies |
| `-ExecutionTimeLimit 0` | Scheduled tasks are killed after 3 days by default, which is fatal for a long-running agent |
| `-AllowStartIfOnBatteries -DontStopIfGoingOnBatteries` | On a laptop, the defaults stop the task when it unplugs |
| `-MultipleInstances IgnoreNew` | A second start is ignored; the instance lock would refuse it anyway |
| `-RunLevel Limited` | Same user, not elevated — see the warning below |

## Two requirements

**Auto-login.** An at-logon trigger does nothing if the machine stops at the
lock screen after a reboot. Enable automatic sign-in (`netplwiz` → clear *Users
must enter a user name and password*), or use an at-startup trigger with *Run
whether user is logged on or not*. Auto-login means the machine boots unlocked —
a deliberate trade-off, reasonable on a private machine, not on a shared one.

**Run as the same user.** Credentials in `.janus/auth.json` are encrypted with a
key derived from the machine ID *and the user name*. A task running as `SYSTEM`
or another account cannot decrypt them: Janus will start and fail to
authenticate with every provider. Keep the trigger bound to your own account.

Note that *Run whether user is logged on or not* runs without a desktop session,
which is fine for the gateway but breaks the browser tool (it drives a real
Chrome). If you use `browser`, prefer auto-login with an at-logon trigger.

## Verify it

```powershell
Start-ScheduledTask -TaskName 'Janus Gateway'
Start-Sleep 15
Get-Content -Tail 20 "$JanusPath\.janus\logs\$(Get-Date -Format yyyy-MM-dd).log"
```

You should see the startup sequence ending with the channel connecting. Then do
the only test that really counts — **reboot the machine** and check that Janus
comes back on its own. Do that before you rely on it.

Useful afterwards:

```powershell
# What is running, and its pid
Get-Content "$JanusPath\.janus\gateway.pid"

# Stop it (the lock file always holds the current pid)
Stop-Process -Id (Get-Content "$JanusPath\.janus\gateway.pid") -Force

# Remove the task
Unregister-ScheduledTask -TaskName 'Janus Gateway' -Confirm:$false
```

Stopping the process by hand lets the task restart it a minute later. To stop
Janus for longer, disable the task first:
`Disable-ScheduledTask -TaskName 'Janus Gateway'`.

## Logs

A gateway started by the task has no console. Enable file logging in
`janus.json` and follow the file instead:

```json
{ "logging": { "file": { "enabled": true } } }
```

```powershell
Get-Content -Wait -Tail 50 "$JanusPath\.janus\logs\$(Get-Date -Format yyyy-MM-dd).log"
```
