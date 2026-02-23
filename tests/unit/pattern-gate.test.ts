/**
 * Unit tests for PatternGate.
 */

import { describe, it, expect } from 'vitest';
import { PatternGate } from '../../src/gates/pattern-gate.js';

describe('PatternGate', () => {
  const defaultPatterns = [
    'rm\\s',
    'git\\s+push',
    'git\\s+reset',
    'npm\\s+publish',
    'docker\\s+rm',
  ];

  it('should gate rm commands', () => {
    const gate = new PatternGate(defaultPatterns);
    expect(gate.shouldGate('exec', { command: 'rm -rf build/' })).toBe(true);
    expect(gate.shouldGate('exec', { command: 'rm file.txt' })).toBe(true);
  });

  it('should gate git push', () => {
    const gate = new PatternGate(defaultPatterns);
    expect(gate.shouldGate('exec', { command: 'git push origin main' })).toBe(true);
    expect(gate.shouldGate('exec', { command: 'git push --force' })).toBe(true);
  });

  it('should gate git reset', () => {
    const gate = new PatternGate(defaultPatterns);
    expect(gate.shouldGate('exec', { command: 'git reset --hard HEAD~1' })).toBe(true);
  });

  it('should gate npm publish', () => {
    const gate = new PatternGate(defaultPatterns);
    expect(gate.shouldGate('exec', { command: 'npm publish' })).toBe(true);
  });

  it('should gate docker rm', () => {
    const gate = new PatternGate(defaultPatterns);
    expect(gate.shouldGate('exec', { command: 'docker rm container-id' })).toBe(true);
  });

  it('should not gate safe commands', () => {
    const gate = new PatternGate(defaultPatterns);
    expect(gate.shouldGate('exec', { command: 'ls -la' })).toBe(false);
    expect(gate.shouldGate('exec', { command: 'git status' })).toBe(false);
    expect(gate.shouldGate('exec', { command: 'git log' })).toBe(false);
    expect(gate.shouldGate('exec', { command: 'npm install' })).toBe(false);
    expect(gate.shouldGate('exec', { command: 'npm test' })).toBe(false);
    expect(gate.shouldGate('exec', { command: 'cat file.txt' })).toBe(false);
  });

  it('should not gate non-exec tools', () => {
    const gate = new PatternGate(defaultPatterns);
    expect(gate.shouldGate('read_file', { path: '/etc/passwd' })).toBe(false);
    expect(gate.shouldGate('write_file', { path: 'test.txt', content: 'rm -rf /' })).toBe(false);
  });

  it('should handle empty command', () => {
    const gate = new PatternGate(defaultPatterns);
    expect(gate.shouldGate('exec', { command: '' })).toBe(false);
    expect(gate.shouldGate('exec', {})).toBe(false);
  });

  it('should work with custom patterns', () => {
    const gate = new PatternGate(['DROP\\s+TABLE', 'DELETE\\s+FROM']);
    expect(gate.shouldGate('exec', { command: 'psql -c "DROP TABLE users"' })).toBe(true);
    expect(gate.shouldGate('exec', { command: 'psql -c "DELETE FROM sessions"' })).toBe(true);
    expect(gate.shouldGate('exec', { command: 'psql -c "SELECT * FROM users"' })).toBe(false);
  });

  it('should pass everything with empty patterns', () => {
    const gate = new PatternGate([]);
    expect(gate.shouldGate('exec', { command: 'rm -rf /' })).toBe(false);
    expect(gate.shouldGate('exec', { command: 'git push --force' })).toBe(false);
  });

  it('should be case-insensitive', () => {
    const gate = new PatternGate(defaultPatterns);
    expect(gate.shouldGate('exec', { command: 'GIT PUSH origin main' })).toBe(true);
    expect(gate.shouldGate('exec', { command: 'RM -rf /' })).toBe(true);
  });

  it('should format action correctly', () => {
    const gate = new PatternGate(defaultPatterns);
    expect(gate.formatAction('exec', { command: 'rm -rf build/' })).toBe('exec: rm -rf build/');
    expect(gate.formatAction('other', { key: 'val' })).toBe('other: {"key":"val"}');
  });
});
