# VOICE-01: Local voice transcription

Status: implemented on the feature branch; automated verification in progress.
Owner acceptance on the target Windows laptop remains pending. See [setup and trial](../../LOCAL-VOICE.md).

Branch: `feature/local-voice`, based on main `f6d55539d845aea0c72def35d5d49302dd0730a9`.
Keep the implementation on this branch and its draft PR until the owner tests it
on Windows. Do not auto-merge this feature under the earlier loop authorization.

## Goal and initial target

Telegram voice messages and audio attachments become ordinary Janus input using
local CPU inference, without an API key or external transcription service.
The owner reports Windows 10 Pro 22H2, an i7-5600U (2 cores/4 threads), 16 GB RAM
and 91 GB free disk. These are supplied specifications, not measurements by this
development environment. Start with a multilingual base model, Polish input,
two inference threads and one running job. Measure quality and latency on the
target laptop before selecting a larger model.

Audio is still downloaded from Telegram. Only speech recognition runs locally;
the resulting text continues through the existing configured Janus model.
Voice replies, live microphone capture, other channels, installing a new OS,
and automatic cloud fallback are outside this change.

## Existing code and gaps

- `src/channels/voice-transcribe.ts` implements remote transcription only.
- `src/channels/telegram-channel.ts` already handles voice/audio, captions,
  user identity, private/family scope, forum topics, reply context and steering.
  Its API-key guard currently excludes a local provider. Error paths mostly log
  and return without a useful user message. An audio attachment is labeled OGG
  regardless of its actual format.
- `src/config/schema.ts` accepts only the existing remote provider and defaults
  transcription to disabled. Preserve both existing defaults and old configs.
- `downloadTelegramFile` reads the entire response into memory. The voice path
  needs a bounded download, not only a metadata size check.
- The current tests cover the remote HTTP helper but not the full voice handler.
- CI currently runs on Ubuntu only. That does not establish Windows process
  cancellation, executable compatibility or target-laptop performance.

## Configuration contract

Extend `voice.provider` with `local`. Keep `groq` as the default for compatibility;
an API key is required only for that provider. Validate selected-provider fields
when voice is enabled. Missing local executables/models produce an actionable
voice readiness error while text messaging remains available.

Proposed local configuration, to be finalized and documented with the code:

```json
{
  "voice": {
    "enabled": true,
    "provider": "local",
    "language": "pl",
    "maxDurationSec": 60,
    "maxFileSizeMb": 20,
    "local": {
      "executablePath": "C:/janus-tools/stt/whisper-cli.exe",
      "converterPath": "C:/janus-tools/audio/ffmpeg.exe",
      "modelPath": "C:/janus-models/ggml-base.bin",
      "threads": 2,
      "timeoutMs": 120000,
      "maxQueuedJobs": 4,
      "maxQueueWaitMs": 120000
    }
  }
}
```

The 60-second duration is the initial laptop trial setting, not a change to the
existing 300-second default. Limits are positive bounded integers. The proposed
timeouts and queue limits are initial values to verify experimentally. Executable
and model paths come only from operator configuration, never messages or tools.
No download during startup or when processing a message. Keep binaries, models,
recordings and secrets outside Git. Installation instructions must pin tested
artifact versions and checksums and retain their supplied license files.

## Processing design

1. Authorize the sender and apply existing group/topic policy before downloading,
   responding with feature errors or starting a process. Preserve mention-only
   group behavior; changing group activation is outside this feature.
2. Validate reported duration/size, then admit the job to a bounded FIFO queue.
   Assign an immutable identity/routing envelope and a cancellation token at
   admission. Deduplicate Telegram deliveries by chat/topic/message ID, not by
   transcription text. Release active queue entries in all failure paths.
3. One local job runs globally per Janus process, including conversion. Reject a
   full queue with a short message; expire stale queued jobs. Download only after
   obtaining the worker slot. Waiting must not block text handling or `/stop`.
4. Download with a byte limit enforced during streaming and a cancellable timeout;
   check metadata and actual bytes. Use a random per-job temporary directory and
   fixed internal names, never the attachment's supplied path/name.
5. Decode local audio to 16 kHz mono 16-bit PCM WAV in a separate process. Bound
   conversion time, output bytes and decoded duration; reject an overlong decoded
   recording instead of silently truncating it. Restrict the converter to local
   file inputs; reject playlists/network references and unsupported formats.
6. Run the configured transcription executable with the pinned CLI contract,
   model, language and thread count. Use `spawn` with argument arrays,
   `shell: false`, `windowsHide: true`; no command interpolation. Read the bounded
   text output file, not progress logs. Preserve the full transcript or reject an
   oversized result explicitly. No automatic retry or cloud fallback.
7. Deliver nonempty text through the existing inbound/steering route exactly once
   per accepted delivery during this process lifetime. Preserve author, user,
   scope, chat/topic, caption, reply and message ID. Transcription grants no new
   permissions. Success means recognized text, not proof of factual accuracy.
8. On success, error, cancellation and shutdown, stop typing indicators, reap the
   child and remove temporary files. Cancellation invalidates queued and running
   work so a late result cannot enter the conversation. Implement and test process
   termination on Windows; do not assume POSIX signals behave identically.

Retain FIFO order among voice jobs. Text must remain responsive while audio is
being processed; a later text message can reach Janus before an earlier voice
transcript. Do not claim total text/audio arrival ordering. `/stop` cancels the
matching chat's pending audio as well as invoking the existing stop behavior;
shutdown cancels all audio. Another chat's jobs remain isolated.

On an authorized request, report disabled/unconfigured voice, oversize input,
queue saturation, timeout, invalid audio, missing executable/model and empty
transcript concisely. Keep full transcripts, raw audio, secrets and raw subprocess
stderr out of diagnostic logs. Record queue/conversion/inference timings, outcome
and audio duration without recording speech content.

## Implementation sequence

- [x] **V1 — contracts and regression tests:** extend schema/example config;
  define a small provider-neutral input/result contract and cancellation;
  retain the existing remote helper behavior. Test local-without-key and legacy
  defaults first. Add tests reproducing silent failures and incorrect MIME.
- [x] **V2 — local execution:** add `src/channels/local-voice-transcribe.ts` and
  a small process helper if needed. Implement bounded conversion/inference,
  fixed temporary paths, readiness validation, cleanup and cancellation.
  Keep engine/model installation separate from npm dependencies.
- [x] **V3 — queue and channel wiring:** add a focused voice service/queue,
  integrate provider selection into Telegram, preserve sender/topic/steering
  semantics, handle `/stop` and channel shutdown. Reuse the existing bus rather
  than introducing a second agent processing loop.
- [x] **V4 — verification and operator tools:** provide an offline diagnostic
  command accepting a synthetic recording, reporting readiness/timings and
  comparing its transcript. Add Windows tests for the voice subset, separate
  from the required Ubuntu job, without weakening existing CI.
- [ ] **V5 — handoff:** document exact tested executable/model versions,
  installation, configuration, branch switch, manual matrix and rollback.
  Publish a draft PR, pass current-commit CI and leave it open for owner testing.
- [ ] **V6 — laptop acceptance:** record the tested SHA, artifact checksums,
  quality and timings; fix failures on the same branch and repeat relevant tests.
  Merge only after owner acceptance and green CI of the final commit.

## Automated verification

Use mocked Telegram and provider calls, generated temporary files, and a harmless
fake child executable/script. No credentials, live API or production data in CI.

| Area | Required behavior |
| --- | --- |
| Config | Disabled defaults and existing remote configs load unchanged; local works without a key; invalid paths/options yield voice readiness errors |
| Remote regression | Preserve remote routing; filename/MIME match actual supplied audio metadata; HTTP and empty-result errors remain handled |
| Process | Arguments survive spaces/Unicode and shell metacharacters; nonzero exit, missing executable/model, malformed output and output limits are handled |
| Cancellation | Timeout, `/stop`, queued cancellation and shutdown reap children; late callbacks never publish; a later job still runs |
| Cleanup | Temporary files disappear on success, every failure and abort; cleanup waits for child exit, including Windows file locks |
| Limits | Metadata lies or missing Content-Length cannot bypass byte/duration caps; corrupt input and converter timeout fail without hanging |
| Queue | At most one conversion/inference job; FIFO voice order; bounded queue and wait; duplicate delivery does not start another job |
| Isolation | Two users and two forum topics never exchange recordings, transcripts or errors; denied senders start no downloads/processes |
| Integration | Voice and audio + caption preserve identity/reply/topic; transcript goes to idle queue or active steering correctly; text remains responsive |
| Diagnostics | Logs do not contain recorded speech, tokens or raw external error bodies |

Run typecheck, full existing Vitest and build on the final implementation.
The current baseline is 1068 passing tests; additions must not remove protections.
Run the voice process/config/queue tests on Windows CI and Ubuntu. Real-engine
tests remain an explicit opt-in using a fixed synthetic Polish fixture and
preinstalled artifacts. Check key words/numbers and reasonable text normalization
rather than requiring identical punctuation across CPU implementations.

## Windows branch trial and rollback

The executable handoff instructions are in `docs/LOCAL-VOICE.md`. The steps below
record the intended trial and rollback procedure.

1. Record `git status`, current branch and SHA. Stop the actual gateway supervisor
   and its restart mechanism before switching. The documented Scheduled Task is
   named `Janus Gateway`, but confirm the installed mechanism rather than assume
   it. Back up configuration and application data after shutdown. Never reset or
   overwrite local changes to force a checkout.
2. Fetch and switch in the existing installation (PowerShell):

   ```powershell
   Set-Location C:\janus-agent
   git fetch origin
   git switch --track origin/feature/local-voice
   npm ci
   npm run typecheck
   npm run build
   ```

   If the branch already exists locally, use `git switch feature/local-voice`
   then `git pull --ff-only`. Stop immediately on any command failure. If local
   history predates a rewrite, do not merge unrelated histories or force-reset;
   prepare a clean checkout and preserve configuration/data separately.
3. Install the pinned local tools/model outside the repository, apply the local
   voice config and run the offline diagnostic first. The released instructions
   must supply the actual implemented diagnostic command, not a placeholder.
4. During the trial, suppress automatic update registration with
   `$env:JANUS_NO_AUTO_UPDATE = '1'` in the launching terminal. This does not disable
   explicit update calls or necessarily remove a pre-existing persisted
   `self_update:check` cron job: inspect and temporarily disable that specific job,
   saving its previous state. Do not run `/update`, `self_update` or the update CLI
   during the trial. Start exactly one gateway via `npm start -- gateway` under
   the same Windows account as the existing installation.
5. Test recordings of about 10, 30 and 60 seconds in Polish, including a date,
   quantity, negation and proper name. Test OGG voice and an MP3 attachment, two
   queued recordings, a text message during transcription, `/stop`, an empty or
   invalid recording, and a recording over the configured limit. Use benign
   requests that do not execute actions while speech accuracy is being assessed.
6. Record cold/warm conversion and inference times, transcript errors, CPU/RAM,
   responsiveness and whether files/processes remain afterward. Initial acceptance
   target: a 30-second recording transcribes within 30 seconds warm, text/control
   handling remains responsive, and dates/numbers/negation in the fixed sample
   are correct. This is a target, not a promised benchmark. If it fails, compare
   models/settings and report the latency/quality tradeoff before proceeding.
7. To roll back: stop the test gateway, restore the saved pre-test voice config
   **before** starting main (main does not accept `provider: local`), switch to the
   recorded original branch or reviewed main, run `npm ci`, verify startup, then
   restore the prior update-job/supervisor state. Unset the session override with
   `Remove-Item Env:JANUS_NO_AUTO_UPDATE`. No session/database migration or deletion
   belongs to this feature. Leave external tools/model installed unless the owner
   chooses to remove them.

## Completion evidence

The implementation handoff must name the remote branch, commit and draft PR,
link successful CI, list tested Windows artifacts, give a copyable working setup
and diagnostic procedure, and distinguish mock tests from the owner's real-device
results. A published plan branch is not a testable voice implementation.
