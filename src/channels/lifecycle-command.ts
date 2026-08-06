/**
 * `/restart` and `/shutdown` — taking Janus down (and bringing it back) from chat.
 *
 * `/shutdown` needs an explicit `now`: it is the one chat command nobody can
 * undo from chat, since only someone at the machine can start Janus again.
 * `/restart` needs no confirmation — it undoes itself.
 */
export type LifecycleAction = 'restart' | 'shutdown' | 'shutdown-unconfirmed';

export function parseLifecycleCommand(text: string): { action: LifecycleAction } | null {
  const normalized = text.trim().toLowerCase().replace(/\s+/g, ' ');

  if (normalized === '/restart') return { action: 'restart' };
  if (normalized === '/shutdown now') return { action: 'shutdown' };
  if (normalized === '/shutdown') return { action: 'shutdown-unconfirmed' };

  return null;
}
