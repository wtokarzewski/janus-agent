#!/usr/bin/env node
/**
 * Standalone test for Browser Operator WS server.
 *
 * Usage:
 *   node chrome-extension/scripts/test-server.mjs
 *
 * What it does:
 *   1. Starts WS server on ws://127.0.0.1:19816
 *   2. Waits for extension to connect
 *   3. Prints all messages (hello, welcome, etc.)
 *   4. After handshake, sends a ping command
 *   5. Keeps running so you can test from the extension popup
 *
 * How to test:
 *   1. Run this script
 *   2. Open Chrome (any profile)
 *   3. Go to chrome://extensions
 *   4. Enable Developer Mode
 *   5. Click "Load unpacked" → select chrome-extension/ folder
 *   6. Extension should connect automatically
 *   7. Click extension icon → popup should show "Connected"
 *   8. Press Ctrl+C to stop
 */

import { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';

const PORT = 19816;
const PROTOCOL_VERSION = 1;

console.log('=== Janus Browser Operator — WS Server Test ===\n');
console.log(`Starting WebSocket server on ws://127.0.0.1:${PORT}...`);

const wss = new WebSocketServer({ port: PORT, host: '127.0.0.1' });

console.log(`✓ Server listening on ws://127.0.0.1:${PORT}\n`);
console.log('Waiting for extension to connect...');
console.log('(Load the extension in Chrome → chrome://extensions → Load unpacked → chrome-extension/)\n');

wss.on('connection', (ws) => {
  console.log('✓ Extension connected!\n');

  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    console.log('← Received:', JSON.stringify(msg, null, 2), '\n');

    // Handle hello → send welcome
    if (msg.type === 'hello') {
      const sessionId = randomUUID();
      const welcome = {
        type: 'welcome',
        sessionId,
        acceptedProtocolVersion: Math.min(msg.protocolVersion ?? 1, PROTOCOL_VERSION),
        ready: true,
        policyMode: 'read_only',
        enabledCapabilities: msg.capabilities ?? [],
        snapshotConfig: {
          viewportOnly: true,
          maxElements: 100,
          maxGroups: 25,
        },
      };
      ws.send(JSON.stringify(welcome));
      console.log('→ Sent welcome:', JSON.stringify(welcome, null, 2), '\n');

      // Send a ping after handshake
      setTimeout(() => {
        const ping = { id: randomUUID(), command: 'ping' };
        ws.send(JSON.stringify(ping));
        console.log('→ Sent ping:', JSON.stringify(ping), '\n');
      }, 1000);

      // Send a snapshot request after 3s
      setTimeout(() => {
        const snapshot = { id: randomUUID(), command: 'snapshot' };
        ws.send(JSON.stringify(snapshot));
        console.log('→ Sent snapshot request:', JSON.stringify(snapshot), '\n');
      }, 3000);
    }
  });

  ws.on('close', () => {
    console.log('✗ Extension disconnected\n');
    console.log('Waiting for reconnection...\n');
  });

  ws.on('error', (err) => {
    console.error('Error:', err.message);
  });
});

wss.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n✗ Port ${PORT} is already in use. Kill the other process first:\n  lsof -ti :${PORT} | xargs kill\n`);
  } else {
    console.error('Server error:', err.message);
  }
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  wss.close();
  process.exit(0);
});

console.log('Press Ctrl+C to stop.\n');
