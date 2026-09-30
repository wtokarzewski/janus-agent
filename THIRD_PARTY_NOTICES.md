# Third-party notices

## OpenClaw — thinking budgets and compaction safeguards

`src/llm/output-budget.ts` adapts the `adjustMaxTokensForThinking` algorithm from
[OpenClaw packages/ai/src/providers/simple-options.ts](https://github.com/openclaw/openclaw/blob/main/packages/ai/src/providers/simple-options.ts),
reviewed on 2026-09-30, together with its Anthropic minimum-budget handling.
The adaptation accepts Janus's explicit numeric thinking budget and optional
verified model cap. Janus uses the same resolver for preflight and SDK dispatch.
No runtime dependency on OpenClaw is required.

`src/agent/compaction-safeguard.ts` adapts the section-first fitting, protected
request/identifier retention and final-artifact auditing approach from
[compaction-safeguard-quality.ts](https://github.com/openclaw/openclaw/blob/main/src/agents/agent-hooks/compaction-safeguard-quality.ts)
and [compaction-safeguard.ts](https://github.com/openclaw/openclaw/blob/main/src/agents/agent-hooks/compaction-safeguard.ts).
Sequential chunk re-distillation follows
[compaction.ts](https://github.com/openclaw/openclaw/blob/main/src/agents/compaction.ts).
The pre-compaction memory checkpoint follows the documented
[memory flush](https://docs.openclaw.ai/concepts/memory#automatic-memory-flush).
These main-branch sources were reviewed on 2026-09-30.

Adaptation boundaries: Janus retains its existing summary headings, 4,096-token
summary output allowance, purpose routing, scoped append-only notes and atomic
session snapshot commits. Its identifier recognizer is bounded and heuristic;
protected active requests are encoded as data. It cancels rather than using
partial summaries or omitting an indivisible oversized group, and continues to
reject length-limited model output. It does not import OpenClaw's runtime,
provider-native compaction, plugin system, or model catalog. Memory chunks share
a durable cursor checkpoint and an in-flight owner rather than a separate agent
turn. These changes require no additional dependencies.


MIT License

Copyright (c) 2026 OpenClaw Foundation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
