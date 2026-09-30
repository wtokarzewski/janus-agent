# Third-party notices

## OpenClaw — thinking budget calculation

`src/llm/output-budget.ts` adapts the `adjustMaxTokensForThinking` algorithm from
[OpenClaw packages/ai/src/providers/simple-options.ts](https://github.com/openclaw/openclaw/blob/main/packages/ai/src/providers/simple-options.ts),
reviewed on 2026-09-30, together with its Anthropic minimum-budget handling.
The adaptation accepts Janus's explicit numeric thinking budget and optional
verified model cap. Janus uses the same resolver for preflight and SDK dispatch.
No runtime dependency on OpenClaw is required.

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
