# Provider circuit breaker + failover classification

**Date:** 2026-07-31
**Status:** Design approved, not yet implemented

## Problem

During an upstream provider incident the agent stays pinned to the primary provider
even though a healthy fallback is configured and registered.

Two distinct defects, found by reading production logs against the code:

### 1. Auth errors never fail over

`isFailoverCandidate()` returns `false` for `invalid_api_key` / `authentication_error`
(`src/llm/retry.ts:103`). The comment justifies this with "failing over won't help".

That reasoning is wrong in a multi-provider setup. Credentials are per-provider and
live in separate entries of `.janus/auth.json`. A failed OAuth token refresh on the
primary says nothing about the fallback's credentials. Today that error class parks
the agent on a provider it cannot authenticate against, with a working fallback one
line below it in the registry.

### 2. No stickiness after a successful failover

`ProviderRegistry` iterates candidates in priority order on **every** call
(`src/llm/provider-registry.ts:85`, `:118`). Nothing remembers that the primary just
failed. During a multi-hour incident every single message repeats the full ladder:

- 3 SDK-level retries inside the provider client (`maxRetries: 3`)
- each bounded by a 2-minute request timeout
- then failover, then the agent's own retry loop (`src/agent/agent-loop.ts:929`,
  `llmRetries < 5`) restarts the whole thing from priority 0

Observed from the outside this is indistinguishable from "failover is broken": the
agent is on the primary at the start of every message, and stays slow for hours.

### Explicitly not a defect

A provider that is slow but returns `200` produces no exception, so no failover fires.
That is correct behaviour, not a bug. Latency-based failover is out of scope — see
Non-goals.

## Goals

- An error class that one provider cannot serve and another can (auth) fails over.
- A provider that has just failed repeatedly is skipped for a cooldown window, so an
  incident costs a bounded number of slow messages instead of every message.
- Recovery is automatic and requires no operator action.
- Behaviour is tunable from config and can be switched off entirely.

## Non-goals

- **Latency-based failover.** Long responses are normal with extended thinking; a
  latency threshold would misfire on healthy traffic.
- **Manual provider override command.** A single global switch would work (one
  `ProviderRegistry` per gateway process, shared by all chats and users), but it needs
  the operator awake and present, and it is owner-only — everyone else waits. Revisit
  only if the automatic behaviour proves insufficient in practice.
- **Persisted breaker state.** A restarted gateway should give the primary a fresh
  chance rather than boot up already demoted.
- **Active health probing.** Cooldown expiry already acts as the probe: the primary
  has `priority: 0`, so the first request after expiry naturally lands on it.

## Design

### Keying breaker state

State is keyed by the **base provider name from config**, not by `ProviderEntry.name`.

`ProviderEntry.name` is the registration label: the default-slot entry registers under
the provider name, the background-slot entry under a decorated variant
(`src/bootstrap.ts:130`). Keying by that label would demote a chat entry while leaving
cron and heartbeat pointed at the same unhealthy upstream.

A new `providerName: string` field on `ProviderEntry` (`src/llm/types.ts:86`) carries
the config value, populated in `bootstrap.ts` from `entry.provider` at both
registration sites.

**Constraint:** no provider name is ever written as a literal in source, and no code
derives one name from another by string manipulation (no suffix stripping, no prefix
matching). Provider names originate in config and are used only as opaque map keys.
Tests fabricate their own names and must not reuse names from any real configuration.

### `src/llm/circuit-breaker.ts` (new, ~50 lines)

```
class ProviderCircuitBreaker {
  constructor(config: CircuitBreakerConfig, now: () => number = Date.now)

  recordFailure(providerName: string): void
  recordSuccess(providerName: string): void
  isOpen(providerName: string): boolean
  filter(entries: ProviderEntry[]): ProviderEntry[]
}
```

- `recordFailure` increments a per-provider counter. On reaching `failureThreshold` it
  sets `trippedUntil = now() + cooldownMs` and logs at info level.
- `recordSuccess` clears both counter and open state.
- `isOpen` returns whether the cooldown is still running. An expired window is cleared
  in place and logged, so recovery is visible in the log.
- `filter` drops open providers — **unless that would leave zero candidates, in which
  case it returns its input unchanged.** With every provider tripped, hitting an
  unhealthy provider beats refusing to answer.
- The injected `now` exists so cooldown expiry is testable without sleeping.

### `ProviderRegistry` integration

- `getCandidates()` passes its result through `breaker.filter()` as the final step,
  after existing purpose filtering.
- `chat()` and `chatStream()` call `recordSuccess(entry.providerName)` on success and
  `recordFailure(entry.providerName)` on failure.
- **Only failover-eligible errors count toward the threshold.** A request-shaped error
  (`context too long`, `malformed`, prompt-too-big `429`) fails on any provider and
  must not demote the one that happened to receive it. The existing
  `isFailoverCandidate()` result is the gate for both failover and counting, so the two
  can never disagree.

### `src/llm/retry.ts`

`isFailoverCandidate()`: the `invalid_api_key` / `authentication_error` branch at line
103 returns `true`, with the comment rewritten to state why (per-provider credentials).
No other classification changes.

### Configuration

```json
"llm": {
  "circuitBreaker": { "enabled": true, "failureThreshold": 2, "cooldownMs": 300000 }
}
```

Zod schema in `src/config/schema.ts` with those defaults, plus an entry in
`janus.example.json`. `enabled: false` restores current behaviour.

**No config edit is required on upgrade.** The section is nested under `llm`, and
`syncNewConfigSections` (`src/commands/update.ts:355`) merges top-level keys only — an
existing `llm` block is preserved untouched, so the new key is never injected. The Zod
schema therefore uses the same `.optional().transform(v => v ?? {...})` pattern as
`cron.cleanup` (`src/config/schema.ts:166`): an absent `llm.circuitBreaker` resolves to
the defaults above. Operators edit `janus.json` only to tune or disable. A restart is
required — `watchConfig()` reloads configuration, not code.

Defaults are 2 failures / 5 minutes: a single hiccup switches nothing, a real incident
costs at most two slow messages, and a still-broken primary costs one retried message
per five minutes.

### Behaviour during an incident

```
message 1:   primary ✗ (failure 1) → failover → fallback ✓
message 2:   primary ✗ (failure 2 → breaker opens, 5 min) → fallback ✓
message 3-N: primary skipped in getCandidates → fallback ✓
after 5 min: primary tried first → ✓ recovers, ✗ opens for another 5 min
```

The agent's retry loop (`src/agent/agent-loop.ts:929`) is left untouched: once the
breaker is open its retries land directly on the fallback, because the primary is no
longer a candidate.

## Testing

New `tests/unit/circuit-breaker.test.ts`, plus cases added to the existing
`tests/unit/provider-registry.test.ts`:

- threshold opens only on the Nth failure, not earlier
- success resets the counter
- a provider returns to the pool after the cooldown elapses (injected clock, no sleep)
- all providers open → filter passes everything through
- a request-shaped error does not increment the counter
- an auth error fails over to the next provider
- `enabled: false` disables filtering and counting entirely

Provider names in tests are fabricated (`alpha`, `beta`) and match no real config.

## Risks

- **Fallback quality.** Sustained incidents route family traffic to the fallback model
  for the duration. Accepted: a slower or weaker answer beats a five-minute wait.
- **Breaker too eager.** Mitigated by `enabled: false` and by both parameters being
  config-tunable without a release.
- **Two failures still cost full ladders.** By construction — the threshold exists so
  that transient noise does not reroute traffic. Lower `failureThreshold` to 1 to trade
  that for faster reaction.
