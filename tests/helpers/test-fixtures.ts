/**
 * Test fixtures — config, temp dirs, mock dependencies for integration tests.
 */

import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JanusConfigSchema, type JanusConfig } from '../../src/config/schema.js';

export function createTestConfig(overrides?: Partial<Record<string, unknown>>): JanusConfig {
  const tempDir = mkdtempSync(join(tmpdir(), 'janus-test-'));

  return JanusConfigSchema.parse({
    workspace: { dir: tempDir, memoryDir: 'memory', sessionsDir: 'sessions', skillsDir: 'skills' },
    database: { enabled: false },
    agent: { maxIterations: 5, summarizationThreshold: 100 },
    streaming: { enabled: false },
    gates: { enabled: false },
    ...overrides,
  });
}

export function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'janus-test-'));
}
