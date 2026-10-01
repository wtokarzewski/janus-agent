# Local voice transcription on Windows

Feature branch: `feature/local-voice`. Keep the draft PR open until the owner has
verified recognition quality and latency on the target laptop. Local recognition
needs no API key. Telegram still delivers the recording, and the transcript goes
to Janus's configured conversation model. Voice replies are a separate TTS option.

## Switch to the feature branch

Stop the running gateway and its automatic restart mechanism first. If using the
Scheduled Task described in [WINDOWS-AUTOSTART.md](WINDOWS-AUTOSTART.md), disable
that task before stopping the process. Use the existing Windows account.
Back up configuration and application data while Janus is stopped. Record the
current branch and commit. Keep local configuration changes; never force a checkout.

In PowerShell, run each command and stop on an error:

```powershell
Set-Location C:\janus-agent
git status --short
git branch --show-current
git rev-parse HEAD
git fetch origin
git switch --track origin/feature/local-voice
npm ci
npm run typecheck
npm run test:voice
```

If the local feature branch already exists, use `git switch feature/local-voice`
and `git pull --ff-only` instead of creating it again. If the checkout has older,
rewritten history, do not combine unrelated histories or reset away local files;
use a clean checkout with separately preserved configuration/data.

## Install local tools once

Requires 64-bit Windows, Node 22, PowerShell 5.1 or later, and internet access for
this installation. No admin account or permanent PATH change is required.
The script installs full verified archives, a multilingual base model and an
example configuration outside the repository. It does not modify `janus.json`,
start Janus or enable any cloud service.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-local-voice.ps1
```

The execution-policy option applies only to that process. Default destination:
`$env:LOCALAPPDATA\Janus\voice`. An existing destination is not overwritten; to
use another folder, pass `-Directory 'C:\janus-tools\voice-trial'`.

Pinned downloads verified by SHA-256:

| Artifact | Version | SHA-256 |
| --- | --- | --- |
| CPU executable archive, x64 | 1.7.6 | `0d2eca299c248f965bd0341bcb219db4b433c7f0c0ce2200d4df85765e8156a9` |
| Audio converter essentials archive | 9.0.2 | `60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba` |
| Multilingual base model | fixed file content | `60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe` |

The installer contains the exact download URLs. Keep the full distributions and
license files. Janus launches these separately installed executables; it does not
embed their code or download them during message handling. On an older CPU, an
executable compatibility error is a failed readiness check, not a reason to
silently switch to a cloud service.

## Configure and check offline

Open the generated `voice-config.json` in the installation directory. Copy only
its `voice` section into the existing `janus.json`; preserve all other settings.
Defaults in that file are Polish, a 60-second recording limit, 20 MB input,
two CPU threads, a two-minute processing timeout and four waiting jobs.
The application-wide default duration remains 300 seconds for existing configs.
Paths are absolute, with Windows separators escaped by the generated JSON.

```powershell
npm start -- voice-check
npm start -- voice-check --audio 'C:\recordings\test-pl.ogg' --show-text
npm start -- voice-check --audio 'C:\recordings\test-pl.ogg' --expect 'nie zmieniaj daty'
```

`voice-check` starts neither Telegram nor the agent, and creates no conversation.
It prints executable/model checksums, decoded duration, conversion/inference time
and a real-time factor (1.0 means processing took as long as the recording).
The transcript is printed only with `--show-text`. `--expect` checks a phrase
ignoring case and punctuation; a mismatch sets a nonzero exit code. Numbers
written as words versus digits may need manual comparison. No transcript is
proof that the model recognized a critical quantity correctly.

## Test Telegram on the laptop

Before launching the test instance, temporarily disable an existing persisted
`self_update:check` job if present and save its original state. The environment
switch below prevents registration of new update checks, but does not disable
explicit update requests or remove an old scheduled job. Do not use update
commands during the branch trial.

```powershell
$env:JANUS_NO_AUTO_UPDATE = '1'
npm start -- gateway
```

Run exactly one instance. Send harmless Polish recordings of about 10, 30 and
60 seconds, including a name, a date, a number and a negation. Compare recognized
content against the recording. Test an MP3 attachment with a caption, two queued
recordings, a text message during recognition, and `/stop`. Check missing model,
invalid audio, an overlong recording and a full queue produce readable errors.
Test in a private chat first. Mention-only group policy continues to ignore voice.

Initial target on the reported two-core laptop: a 30-second recording should
finish within 30 seconds after warm-up. This is an acceptance target, not a
measured promise. Record cold and warm times, accuracy and text responsiveness.
Windows CI runs on a different machine; its timing does not predict laptop speed.

## Behavior and limits

- Local jobs, including download/conversion, run one at a time in a bounded FIFO
  queue. Waiting expires after two minutes by default. Later text may be handled
  before an earlier voice recording; the text handler is not blocked by recognition.
- `/stop` also cancels audio for the same chat/topic. Shutdown cancels all pending
  audio. A late cancelled result cannot be published. Jobs are not persisted
  across restart; a recording interrupted by restart must be sent again.
- Duplicate delivery suppression is in-memory, up to 1000 recent message IDs for
  ten minutes, in addition to running/waiting job IDs. It is not durable exactly-once
  delivery across restarts.
- OGG, MP3, WAV, FLAC and M4A containers are accepted by the local path. The
  converter checks actual decoded duration; exceeding a limit rejects the recording
  instead of silently truncating it. Input bytes, decoded output and transcript
  size are bounded. Conversion has a 30-second ceiling within the overall timeout.
- Temporary recordings and results are removed after the child exits on success,
  failure or cancellation. A hard OS/process crash can leave a temporary directory;
  there is no automatic deletion of other sessions' files at startup.
- Local errors do not fall back to a remote provider. Existing remote configuration
  remains supported, with an API key required only for that provider. Missing local
  files disable voice readiness rather than text messaging.
- New transcription diagnostics contain durations/outcomes, not speech content or
  raw subprocess errors. The transcript still becomes normal Janus conversation data.
- Changing voice settings applies to newly admitted jobs; queued jobs keep their
  original configuration and sender identity. Language defaults to automatic
  detection when omitted; the supplied trial configuration explicitly sets `pl`.

## Automated and real-engine checks

`npm run test:voice` tests schema compatibility, remote metadata, real child
process cancellation/output limits, temp cleanup, bounded downloads, queue
isolation and Telegram routing with synthetic updates. It does not require a
model or network access. Full existing tests remain part of the normal CI job.

The separate Windows CI job installs the pinned artifacts, synthesizes harmless
English speech using Windows, and transcribes WAV, OGG and MP3 through the real
CPU engine. Its optional local equivalent (PowerShell 5.1) is:

```powershell
powershell -NoProfile -File .\scripts\test-local-voice-windows.ps1 -ToolsDirectory "$env:LOCALAPPDATA\Janus\voice"
```

This test uses a temporary config, does not touch the running installation, and
requires an installed Windows speech voice. It verifies integration, not Polish
quality or target-laptop performance; those require the manual trial above.

## Return to main

Stop the test gateway. Restore the saved pre-test voice configuration **before**
starting main: the current main does not accept `provider: local`. Switch to the
recorded original branch or reviewed `main`, run `npm ci`, and check startup.
Restore the original update-job and supervisor state; remove the terminal override
with `Remove-Item Env:JANUS_NO_AUTO_UPDATE` if it is set. Keep conversation data;
this feature requires no database/session migration. Installed tools and models
can remain outside the checkout for another trial.
