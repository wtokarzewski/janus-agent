// Patterns that indicate command obfuscation / encoded payloads
const OBFUSCATION_PATTERNS: RegExp[] = [
  /base64\s+(-d|--decode)\s*\|/i,                    // base64 -d | sh
  /\|\s*(ba)?sh\b/i,                                  // pipe to shell (after decode)
  /\bxxd\s+-r\s*\|/i,                                 // xxd hex decode piped
  /printf\s+('\\x|"\\x)/i,                            // printf hex sequences
  /\beval\s+\$\(/i,                                    // eval $(...)
  /\bpython[23]?\s+-c\s+.*\b(exec|eval|import\s+os)\b/i, // python exec/eval
  /\bperl\s+-e\s+.*\b(system|exec)\b/i,               // perl system/exec
  /\$\{[^}]*\}.*\brm\b/i,                             // variable expansion + rm
];

// Legitimate tools that use eval/pipe-to-shell patterns
const OBFUSCATION_WHITELIST: RegExp[] = [
  /\bnvm\b/i,
  /\bbrew\b/i,
  /\brustup\b/i,
  /\bconda\b/i,
  /\bdocker\b/i,
];

// Sensitive paths that should require confirmation before writing
const SENSITIVE_PATH_PATTERNS: RegExp[] = [
  /^\/etc\//,
  /[/\\]\.ssh[/\\]/,
  /[/\\]\.env$/,
  /[/\\]\.env\./,
  /[/\\]\.git[/\\]config$/,
  /[/\\]\.npmrc$/,
  /[/\\]\.netrc$/,
  /[/\\]id_rsa/,
  /[/\\]credentials/i,
  /[/\\]\.aws[/\\]/,
  /[/\\]\.kube[/\\]/,
];

/**
 * PatternGate — matches tool calls against configurable regex patterns.
 * Gates: exec (shell commands), write_file/edit_file (sensitive paths).
 */
export class PatternGate {
  private patterns: RegExp[];

  constructor(patterns: string[]) {
    this.patterns = patterns.map(p => new RegExp(p, 'i'));
  }

  shouldGate(toolName: string, args: Record<string, unknown>): boolean {
    // Gate exec commands
    if (toolName === 'exec') {
      const command = typeof args.command === 'string' ? args.command : '';
      if (!command) return false;
      if (this.patterns.some(p => p.test(command))) return true;
      if (this.isObfuscated(command)) return true;
      return false;
    }

    // Gate file writes to sensitive paths
    if (toolName === 'write_file' || toolName === 'edit_file') {
      const path = typeof args.path === 'string' ? args.path
        : typeof args.file_path === 'string' ? args.file_path : '';
      if (path && SENSITIVE_PATH_PATTERNS.some(p => p.test(path))) return true;
      return false;
    }

    return false;
  }

  private isObfuscated(command: string): boolean {
    // Skip whitelisted tools
    if (OBFUSCATION_WHITELIST.some(w => w.test(command))) return false;
    return OBFUSCATION_PATTERNS.some(p => p.test(command));
  }

  formatAction(toolName: string, args: Record<string, unknown>): string {
    if (toolName === 'exec') {
      const cmd = typeof args.command === 'string' ? args.command : String(args.command);
      return `exec: ${cmd}`;
    }
    if (toolName === 'write_file' || toolName === 'edit_file') {
      const path = typeof args.path === 'string' ? args.path
        : typeof args.file_path === 'string' ? args.file_path : '?';
      return `${toolName}: ${path} (sensitive path)`;
    }
    return `${toolName}: ${JSON.stringify(args)}`;
  }
}
