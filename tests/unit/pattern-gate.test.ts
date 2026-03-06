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

  describe('self_update gating', () => {
    const gate = new PatternGate([]);

    it('should gate self_update with action "update"', () => {
      expect(gate.shouldGate('self_update', { action: 'update' })).toBe(true);
    });

    it('should not gate self_update with action "check"', () => {
      expect(gate.shouldGate('self_update', { action: 'check' })).toBe(false);
    });

    it('should format self_update action', () => {
      expect(gate.formatAction('self_update', { action: 'update' })).toContain('self_update');
      expect(gate.formatAction('self_update', { action: 'update' })).toContain('pull');
    });
  });

  describe('obfuscation detection', () => {
    // Use empty patterns to test only obfuscation detection
    const gate = new PatternGate([]);

    it('should gate base64 decode piped to shell', () => {
      expect(gate.shouldGate('exec', { command: 'echo cm0gLXJm | base64 -d | sh' })).toBe(true);
      expect(gate.shouldGate('exec', { command: 'echo cm0gLXJm | base64 --decode | bash' })).toBe(true);
    });

    it('should gate xxd hex decode piped to shell', () => {
      expect(gate.shouldGate('exec', { command: 'echo 726d202d7266 | xxd -r | sh' })).toBe(true);
    });

    it('should gate printf hex sequences', () => {
      expect(gate.shouldGate('exec', { command: "printf '\\x72\\x6d'" })).toBe(true);
      expect(gate.shouldGate('exec', { command: 'printf "\\x72\\x6d"' })).toBe(true);
    });

    it('should gate eval $(...)', () => {
      expect(gate.shouldGate('exec', { command: 'eval $(echo "rm -rf /")' })).toBe(true);
    });

    it('should gate python exec/eval', () => {
      expect(gate.shouldGate('exec', { command: 'python3 -c "import os; os.system(\'rm -rf /\')"' })).toBe(true);
      expect(gate.shouldGate('exec', { command: 'python -c "exec(\'rm\')"' })).toBe(true);
    });

    it('should gate perl system', () => {
      expect(gate.shouldGate('exec', { command: 'perl -e "system(\'rm -rf /\')"' })).toBe(true);
    });

    it('should gate variable expansion with rm', () => {
      expect(gate.shouldGate('exec', { command: '${CMD} rm -rf /' })).toBe(true);
    });

    it('should not gate whitelisted tools', () => {
      expect(gate.shouldGate('exec', { command: 'eval "$(brew shellenv)"' })).toBe(false);
      expect(gate.shouldGate('exec', { command: 'eval "$(nvm init)"' })).toBe(false);
      expect(gate.shouldGate('exec', { command: 'eval "$(conda shell.bash hook)"' })).toBe(false);
      expect(gate.shouldGate('exec', { command: 'docker build . | bash' })).toBe(false);
    });

    it('should not gate normal commands', () => {
      expect(gate.shouldGate('exec', { command: 'echo hello' })).toBe(false);
      expect(gate.shouldGate('exec', { command: 'cat file.txt' })).toBe(false);
      expect(gate.shouldGate('exec', { command: 'npm install' })).toBe(false);
      expect(gate.shouldGate('exec', { command: 'python3 -c "print(1+1)"' })).toBe(false);
      expect(gate.shouldGate('exec', { command: 'base64 file.txt' })).toBe(false);
    });
  });
});
