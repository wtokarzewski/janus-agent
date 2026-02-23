# Contributing to Janus

Thanks for your interest in contributing! Here's how to get started.

## Reporting Bugs

Open an issue using the **Bug Report** template. Include:
- Steps to reproduce
- Expected vs actual behavior
- Your environment (OS, Node version, provider)

## Suggesting Features

Open an issue using the **Feature Request** template. Describe the problem you're solving and your proposed approach.

## Development Setup

```bash
git clone https://github.com/wtokarzewski/janus-agent.git
cd janus-agent
npm install
npm test
npm run typecheck
```

## Making Changes

1. Fork the repo and create a branch from `main`
2. Write your code — follow existing conventions (TypeScript, ESM, English comments)
3. Add tests if applicable
4. Run `npm test && npm run typecheck` to verify
5. Open a PR against `main`

## Code Style

- TypeScript with ESM (`"type": "module"`)
- Code and comments in English
- Follow existing patterns — read the code around your changes
- Keep changes focused — one concern per PR

## Code of Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). Be respectful.
