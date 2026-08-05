import { spawn } from 'node:child_process';
import { resolve, relative } from 'node:path';
import type { ContextualTool, ToolContext } from '../types.js';
import { getShellConfig, killProcessTree } from '../../utils/shell.js';
import { stripInvisibleChars, safeSlice } from '../../utils/sanitize.js';

const IS_WIN = process.platform === 'win32';

const DEFAULT_DENY_PATTERNS = [
  'rm\\s+-rf\\s+/',
  'rm\\s+-rf\\s+~',
  'sudo\\s+rm',
  'mkfs',
  ':\\(\\)\\{:|:&\\};:',
  '>\\s*/dev/sda',
  'dd\\s+if=/dev/zero',
  'sqlite3\\s+.*\\.janus/',
  'sqlite3\\s+.*janus\\.db',
  // Env injection: runtime-specific vars that execute code on process start
  '(JAVA_TOOL_OPTIONS|_JAVA_OPTIONS)\\s*=',
  '(DOTNET_STARTUP_HOOKS|COMPlus_)\\s*=',
  '(LD_PRELOAD|DYLD_INSERT_LIBRARIES)\\s*=',
  '(PYTHONSTARTUP|PYTHONPATH)\\s*=.*python',
  '(NODE_OPTIONS)\\s*=.*--require',
  '(PERL5OPT|RUBYOPT)\\s*=',
];

export class ExecTool implements ContextualTool {
  name = 'exec';
  description = 'Execute a shell command. Use for running scripts, installing packages, git operations, etc.';
  parameters = {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to execute' },
      working_dir: { type: 'string', description: 'Working directory (relative to workspace). Defaults to workspace root.' },
    },
    required: ['command'],
  };

  private workspaceDir = process.cwd();
  private denyPatterns: RegExp[] = DEFAULT_DENY_PATTERNS.map(p => new RegExp(p));
  private timeoutMs = 30_000;
  private maxOutput = 50_000;

  setContext(ctx: ToolContext): void {
    this.workspaceDir = ctx.workspaceDir;

    if (ctx.execDenyPatterns) {
      this.denyPatterns = ctx.execDenyPatterns.map(p => {
        try {
          return new RegExp(p);
        } catch {
          // If pattern isn't valid regex, escape it and use as literal match
          return new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        }
      });
    }

    if (ctx.execTimeout) {
      this.timeoutMs = ctx.execTimeout;
    }
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const raw = String(args.command ?? '');
    if (!raw) return 'Error: No command provided';
    // Strip invisible Unicode chars to prevent deny-pattern bypass (S4)
    const command = stripInvisibleChars(raw);

    // Safety: deny pattern check
    for (const pattern of this.denyPatterns) {
      if (pattern.test(command)) {
        return `Error: Command blocked by safety rules: ${command}`;
      }
    }

    // Resolve working directory (restrict to workspace)
    const workingDir = args.working_dir
      ? resolve(this.workspaceDir, String(args.working_dir))
      : resolve(this.workspaceDir);

    // Safety: restrict to workspace — working_dir must be inside workspace
    const rel = relative(resolve(this.workspaceDir), workingDir);
    if (rel.startsWith('..') || resolve(workingDir) !== workingDir && rel.startsWith('/')) {
      return `Error: working_dir must be inside workspace. Got: ${args.working_dir}`;
    }

    const { shell, args: shellArgs } = getShellConfig();

    return new Promise<string>((resolveP) => {
      const child = spawn(shell, [...shellArgs, command], {
        cwd: workingDir,
        detached: !IS_WIN,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, HOME: process.env.HOME },
      });

      let stdout = '';
      let stderr = '';
      let killed = false;
      let settled = false;

      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

      /** Report once, with whatever output arrived before this point. */
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);

        let output = '';
        if (stdout) output += stdout;
        if (stderr) output += (output ? '\n' : '') + stderr;
        if (killed) {
          const note = `Command timed out after ${this.timeoutMs}ms`;
          output = output ? `${output}\n${note}` : note;
        }

        // Truncate
        if (output.length > this.maxOutput) {
          output = safeSlice(output, 0, this.maxOutput) + '\n... (output truncated)';
        }

        resolveP(output || '(no output)');
      };

      const timer = setTimeout(() => {
        killed = true;
        if (child.pid) killProcessTree(child.pid, { graceMs: 2000 });
        // Ensure zombie reaping: unref child so Node doesn't wait, but OS reaps (CR-BG)
        child.unref();
        // Report now rather than waiting for 'close'. Teardown is best effort:
        // a process that ignores SIGTERM waits for the SIGKILL grace period, and
        // on Windows a grandchild that survives taskkill keeps the inherited
        // stdout pipe open, so 'close' may never arrive at all.
        finish();
      }, this.timeoutMs);

      child.on('close', finish);

      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolveP(`Error: ${err.message}`);
      });
    });
  }
}
