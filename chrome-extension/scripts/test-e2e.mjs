#!/usr/bin/env node
/**
 * End-to-end test for Browser Operator.
 *
 * Usage:
 *   node chrome-extension/scripts/test-e2e.mjs
 *
 * What it does:
 *   1. Builds the extension (if dist/ is stale)
 *   2. Starts WS server on ws://127.0.0.1:19816
 *   3. Launches Chrome with dedicated Janus profile + extension loaded
 *   4. Waits for extension to connect and handshake
 *   5. Sends: ping → getCurrentUrl → navigate(google.com) → snapshot
 *   6. Prints results
 *   7. Keeps Chrome open for manual testing
 *
 * Environment:
 *   CHROME_PATH  — override Chrome binary (auto-detected otherwise)
 *   JANUS_PROFILE — override profile dir (default: ~/.janus/chrome-profile-test)
 */

import { WebSocketServer } from 'ws';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const PORT = 19816;
const PROTOCOL_VERSION = 1;
const EXTENSION_DIR = resolve(import.meta.dirname, '..');
const PROFILE_DIR = process.env.JANUS_PROFILE ?? resolve(process.env.HOME ?? '~', '.janus', 'chrome-profile-test');

// ─── Find Chrome ─────────────────────────────────────────────────────

function findChrome() {
  const envPath = process.env.CHROME_PATH;
  if (envPath && existsSync(envPath)) return envPath;

  const candidates = {
    darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
    linux: ['google-chrome', 'google-chrome-stable', 'chromium-browser'],
    win32: ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'],
  };

  for (const path of candidates[process.platform] ?? []) {
    if (existsSync(path)) return path;
  }
  return null;
}

// ─── Helpers ─────────────────────────────────────────────────────────

function sendCommand(ws, command, args) {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const timeout = setTimeout(() => reject(new Error(`Timeout: ${command}`)), 15000);

    const handler = (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id === id) {
        ws.removeListener('message', handler);
        clearTimeout(timeout);
        resolve(msg);
      }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ id, command, args }));
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Main ────────────────────────────────────────────────────────────

console.log('=== Janus Browser Operator — End-to-End Test ===\n');

// Step 1: Check extension is built
if (!existsSync(resolve(EXTENSION_DIR, 'dist', 'background.js'))) {
  console.log('Building extension...');
  const build = spawn('node', ['scripts/build.mjs'], { cwd: EXTENSION_DIR, stdio: 'inherit' });
  await new Promise((res, rej) => { build.on('close', c => c === 0 ? res() : rej(new Error('Build failed'))); });
  console.log('');
}

// Step 2: Start WS server
console.log(`Starting WS server on ws://127.0.0.1:${PORT}...`);
const wss = new WebSocketServer({ port: PORT, host: '127.0.0.1' });
console.log('✓ Server ready\n');

// Step 3: Launch Chrome
const chromePath = findChrome();
if (!chromePath) {
  console.error('✗ Chrome not found. Set CHROME_PATH.');
  process.exit(1);
}

console.log(`Launching Chrome...`);
console.log(`  Binary: ${chromePath}`);
console.log(`  Profile: ${PROFILE_DIR}`);
console.log(`  Extension: ${EXTENSION_DIR}\n`);

const chrome = spawn(chromePath, [
  `--user-data-dir=${PROFILE_DIR}`,
  `--load-extension=${EXTENSION_DIR}`,
  '--no-first-run',
  '--no-default-browser-check',
  'about:blank',
], { detached: true, stdio: 'ignore' });
chrome.unref();

// Step 4: Wait for extension
console.log('Waiting for extension to connect...\n');

const extensionWs = await new Promise((resolveWs) => {
  wss.on('connection', (ws) => {
    console.log('✓ Extension connected!\n');
    resolveWs(ws);
  });

  // Timeout after 30s
  setTimeout(() => {
    console.error('✗ Extension did not connect within 30s.');
    console.error('  Make sure the extension is loaded in Chrome.');
    console.error('  Try: chrome://extensions → enable Developer Mode → check for errors');
    process.exit(1);
  }, 30000);
});

// Step 5: Handle handshake
await new Promise((resolveHandshake) => {
  extensionWs.on('message', (data) => {
    const msg = JSON.parse(data.toString());

    if (msg.type === 'hello') {
      console.log('← hello:', JSON.stringify(msg, null, 2), '\n');

      const welcome = {
        type: 'welcome',
        sessionId: randomUUID(),
        acceptedProtocolVersion: Math.min(msg.protocolVersion ?? 1, PROTOCOL_VERSION),
        ready: true,
        policyMode: 'read_only',
        enabledCapabilities: msg.capabilities ?? [],
        snapshotConfig: { viewportOnly: true, maxElements: 100, maxGroups: 25 },
      };
      extensionWs.send(JSON.stringify(welcome));
      console.log('→ welcome sent\n');
      resolveHandshake();
    }
  });
});

await sleep(1000);

// Step 6: Run test commands
console.log('─── Running test commands ───\n');

// Ping
console.log('1. ping');
const pong = await sendCommand(extensionWs, 'ping');
console.log(`   Result: ${pong.ok ? '✓ pong' : '✗ failed'}\n`);

// Get current URL
console.log('2. getCurrentUrl');
const urlResult = await sendCommand(extensionWs, 'getCurrentUrl');
console.log(`   Result: ${urlResult.ok ? urlResult.result?.url ?? '(empty)' : '✗ failed'}\n`);

// Navigate to Google
console.log('3. navigate → google.com');
const navResult = await sendCommand(extensionWs, 'navigate', { url: 'https://www.google.com' });
console.log(`   Result: ${navResult.ok ? '✓ navigated' : '✗ failed'}\n`);

await sleep(3000); // Wait for page load

// Snapshot
console.log('4. snapshot');
const snapResult = await sendCommand(extensionWs, 'snapshot');
if (snapResult.ok && snapResult.result) {
  const snap = snapResult.result;
  console.log(`   ✓ Page: ${snap.page?.title} (${snap.page?.url})`);
  console.log(`   ✓ Elements: ${snap.elements?.length ?? 0}`);
  console.log(`   ✓ Groups: ${snap.groups?.length ?? 0}`);
  console.log(`   ✓ State: ${snap.state?.loadingState}`);
  console.log(`   ✓ Schema: v${snap.schemaVersion}`);
  if (snap.elements?.length > 0) {
    console.log('   First 5 elements:');
    for (const el of snap.elements.slice(0, 5)) {
      console.log(`     ${el.id}: [${el.kind}] ${el.tag} "${el.text?.slice(0, 50)}" ${el.semanticHints?.length ? `(${el.semanticHints.join(', ')})` : ''}`);
    }
  }
} else {
  console.log(`   ✗ failed: ${snapResult.error?.message ?? 'unknown error'}`);
}

console.log('\n─── Test complete ───');
console.log('\nChrome is still running. You can:');
console.log('  - Click the Janus extension icon to see the popup');
console.log('  - Navigate to any page and the extension stays connected');
console.log('  - Press Ctrl+C to stop the server\n');

// Keep alive
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  wss.close();
  process.exit(0);
});
