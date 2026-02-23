/**
 * PatternGate — matches tool calls against configurable regex patterns.
 * Only gates the `exec` tool (MVP). Can be expanded to other tools later.
 */
export class PatternGate {
  private patterns: RegExp[];

  constructor(patterns: string[]) {
    this.patterns = patterns.map(p => new RegExp(p, 'i'));
  }

  shouldGate(toolName: string, args: Record<string, unknown>): boolean {
    if (toolName !== 'exec') return false;

    const command = typeof args.command === 'string' ? args.command : '';
    if (!command) return false;

    return this.patterns.some(p => p.test(command));
  }

  formatAction(toolName: string, args: Record<string, unknown>): string {
    if (toolName === 'exec') {
      const cmd = typeof args.command === 'string' ? args.command : String(args.command);
      return `exec: ${cmd}`;
    }
    return `${toolName}: ${JSON.stringify(args)}`;
  }
}
