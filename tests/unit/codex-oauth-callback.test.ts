import { describe, it, expect } from 'vitest';
import http from 'node:http';
import { startCallbackServer } from '../../src/auth/codex-oauth.js';

const CALLBACK_PORT = 1455;

/** Request the callback URL over a keep-alive connection, like a browser does. */
function callBack(path: string, agent: http.Agent): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: CALLBACK_PORT, path, agent },
      (res) => {
        res.resume();
        res.on('end', () => resolve());
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function withTimeout(promise: Promise<void>, ms: number, what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} after ${ms}ms`)), ms);
    promise.then(
      () => { clearTimeout(timer); resolve(); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

describe('codex OAuth callback server', () => {
  it('releases the browser keep-alive socket after the callback', async () => {
    // server.close() alone only stops new connections; the browser's idle
    // keep-alive socket kept the Node event loop — and the setup wizard —
    // alive after login finished.
    const { code, server } = startCallbackServer('state-abc');
    const closed = new Promise<void>(resolve => server.once('close', () => resolve()));
    await new Promise(resolve => server.once('listening', resolve));

    const agent = new http.Agent({ keepAlive: true });
    try {
      await callBack('/auth/callback?code=the-code&state=state-abc', agent);

      await expect(code).resolves.toBe('the-code');
      await withTimeout(closed, 1000, 'server still holding the event loop');
    } finally {
      agent.destroy();
      server.close();
    }
  });

  it('rejects and shuts down on a state mismatch', async () => {
    const { code, server } = startCallbackServer('state-abc');
    const rejection = code.then(() => null, (err: Error) => err); // attach early — it settles during the request
    const closed = new Promise<void>(resolve => server.once('close', () => resolve()));
    await new Promise(resolve => server.once('listening', resolve));

    const agent = new http.Agent({ keepAlive: true });
    try {
      await callBack('/auth/callback?code=the-code&state=wrong', agent);

      expect((await rejection)?.message).toMatch(/state mismatch/i);
      await withTimeout(closed, 1000, 'server still holding the event loop');
    } finally {
      agent.destroy();
      server.close();
    }
  });
});
