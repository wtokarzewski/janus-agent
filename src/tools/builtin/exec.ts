import { execFile } from 'node:child_process';
import { resolve, relative } from 'node:path';
import type { ContextualTool, ToolContext } from '../types.js';

const DEFAULT_DENY_PATTERNS = [
  'rm\\s+-rf\\s+/',
  'rm\\s+-rf\\s+~',
  'sudo\\s+rm',
  'mkfs',
  ':\\(\\)\\{:|:&\\};:',
  '>\\s*/dev/sda',
  'dd\\s+if=/dev/zero',
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
    const command = String(args.command ?? '');
    if (!command) return 'Error: No command provided';

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

    return new Promise<string>((resolveP) => {
      execFile('sh', ['-c', command], {
        cwd: workingDir,
        timeout: this.timeoutMs,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, HOME: process.env.HOME },
      }, (error, stdout, stderr) => {
        let output = '';
        if (stdout) output += stdout;
        if (stderr) output += (output ? '\n' : '') + stderr;
        if (error && !output) output = error.message;

        // Truncate
        if (output.length > this.maxOutput) {
          output = output.slice(0, this.maxOutput) + '\n... (output truncated)';
        }

        resolveP(output || '(no output)');
      });
    });
  }
}
