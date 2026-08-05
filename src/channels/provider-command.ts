/**
 * `/provider` — show which LLM provider is serving traffic and switch it.
 *
 * Shared by CLI and Telegram so both channels report the same thing. Answering
 * with a number from the list switches; `0` puts it back on automatic order.
 * The switch is a runtime pin on the registry: it applies to the next message,
 * needs no restart, and is deliberately not written to config — it is an
 * override for the current incident, not a new default.
 */

export interface ProviderStatus {
  providerName: string;
  model: string;
  priority: number;
  pinned: boolean;
  demoted: boolean;
}

export interface PinnableRegistry {
  status(): ProviderStatus[];
  pin(providerName: string): boolean;
  unpin(): void;
  getPinned(): string | undefined;
}

const AUTO_LABEL = 'automatic (priority + circuit breaker)';

export function handleProviderCommand(registry: PinnableRegistry, arg: string | undefined): string {
  const wanted = arg?.trim().toLowerCase();
  const rows = ordered(registry);

  if (!wanted) return menu(registry, rows);

  if (wanted === '0' || wanted === 'auto') {
    registry.unpin();
    return `Back to ${AUTO_LABEL}.\n\n${menu(registry, ordered(registry))}`;
  }

  const target = /^\d+$/.test(wanted)
    ? rows[Number(wanted) - 1]?.providerName
    : rows.find(r => r.providerName === wanted)?.providerName;

  if (!target || !registry.pin(target)) {
    const names = rows.map(r => r.providerName).join(', ');
    return `Unknown provider "${wanted}". Pick 0–${rows.length} (0 = automatic), or a name: ${names}.`;
  }

  return `Now using "${target}" first. Not written to config — a restart returns to ${AUTO_LABEL}.\n\n`
    + menu(registry, ordered(registry));
}

/** Registered providers in priority order — the order the menu numbers follow. */
function ordered(registry: PinnableRegistry): ProviderStatus[] {
  return [...registry.status()].sort((a, b) => a.priority - b.priority);
}

function menu(registry: PinnableRegistry, rows: ProviderStatus[]): string {
  if (rows.length === 0) return 'No providers registered.';

  const pinned = registry.getPinned();
  // Without a pin, traffic goes to the first provider the breaker hasn't demoted.
  const current = pinned ?? rows.find(r => !r.demoted)?.providerName ?? rows[0].providerName;

  const lines = rows.map((r, i) => {
    const role = i === 0 ? 'default' : rows.length === 2 ? 'fallback' : `fallback ${i}`;
    const notes: string[] = [];
    if (r.providerName === current) notes.push('current');
    if (r.pinned) notes.push('pinned');
    if (r.demoted) notes.push('cooling down after failures');
    const suffix = notes.length > 0 ? ` (${notes.join(', ')})` : '';
    return `  ${i + 1}. ${r.providerName} — ${r.model} — ${role}${suffix}`;
  });

  const autoNote = pinned ? '' : ' (current)';
  return [
    'Providers:',
    `  0. ${AUTO_LABEL}${autoNote}`,
    ...lines,
    '',
    `Reply /provider 0-${rows.length} to switch.`,
  ].join('\n');
}
