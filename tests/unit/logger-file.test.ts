import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { info, error, setLogLevel, initFileLogging } from '../../src/utils/logger.js';

const ESC = String.fromCharCode(27); // ANSI escape byte

/** Local YYYY-MM-DD, matching the logger's daily-file naming. */
function today(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

describe('file logging', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'janus-log-'));
    setLogLevel('debug');
  });

  afterEach(() => {
    initFileLogging(null); // disable so other suites are unaffected
    rmSync(dir, { recursive: true, force: true });
  });

  it('appends the same message to a daily log file as the terminal sees', () => {
    initFileLogging({ dir });
    info('hello world');

    const content = readFileSync(join(dir, `${today()}.log`), 'utf-8');
    expect(content).toContain('[INFO]');
    expect(content).toContain('hello world');
  });

  it('names the log file by the current date', () => {
    initFileLogging({ dir });
    info('anything');

    const files = readdirSync(dir).filter((f) => f.endsWith('.log'));
    expect(files).toContain(`${today()}.log`);
  });

  it('masks secrets in the file output', () => {
    initFileLogging({ dir });
    const token = '1234567890:FAKE_telegram_token_for_tests_0000000000';
    info(`telegram token is ${token}`);

    const content = readFileSync(join(dir, `${today()}.log`), 'utf-8');
    expect(content).not.toContain(token);
    expect(content).toContain('***');
  });

  it('writes plain text without ANSI color codes', () => {
    initFileLogging({ dir });
    error('boom');

    const content = readFileSync(join(dir, `${today()}.log`), 'utf-8');
    expect(content).not.toContain(ESC);
    expect(content).toContain('[ERROR]');
    expect(content).toContain('boom');
  });

  it('serializes extra args into the file line', () => {
    initFileLogging({ dir });
    info('context', { userId: 'wojtek', scope: 'family' });

    const content = readFileSync(join(dir, `${today()}.log`), 'utf-8');
    expect(content).toContain('wojtek');
    expect(content).toContain('family');
  });

  it('does not write any file when file logging is disabled', () => {
    initFileLogging(null);
    info('should not be persisted');

    const files = readdirSync(dir).filter((f) => f.endsWith('.log'));
    expect(files).toHaveLength(0);
  });

  it('deletes log files older than retentionDays on init', () => {
    writeFileSync(join(dir, '2000-01-01.log'), 'ancient\n');
    initFileLogging({ dir, retentionDays: 14 });

    const files = readdirSync(dir);
    expect(files).not.toContain('2000-01-01.log');
  });

  it('keeps log files within the retention window', () => {
    writeFileSync(join(dir, `${today()}.log`), 'recent\n');
    initFileLogging({ dir, retentionDays: 14 });

    const files = readdirSync(dir);
    expect(files).toContain(`${today()}.log`);
  });
});
