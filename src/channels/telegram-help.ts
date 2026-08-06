/**
 * `/help` — the built-in commands, listed where the user actually is.
 *
 * The CLI has had a help screen since the beginning; on Telegram there was no
 * way to discover that `/provider` or `/stop` even exist. Kept next to the
 * handlers so a new command is one edit away from being documented.
 */

export interface TelegramCommand {
  name: string;
  description: string;
}

export const TELEGRAM_COMMANDS: TelegramCommand[] = [
  { name: '/help', description: 'ta lista' },
  { name: '/provider', description: 'pokaż lub przełącz providera LLM (0 = automatyczny)' },
  { name: '/model', description: 'pokaż lub zmień model (wymaga restartu)' },
  { name: '/stop', description: 'przerwij to, co Janus właśnie robi' },
  { name: '/whoami', description: 'twoje ID czatu i użytkownika — do konfiguracji' },
];

export function formatTelegramHelp(): string {
  const lines = TELEGRAM_COMMANDS.map(c => `${c.name} — ${c.description}`);
  return `Komendy:\n${lines.join('\n')}\n\nPoza tym po prostu napisz, o co chodzi.`;
}
