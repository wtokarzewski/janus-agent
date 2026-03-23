/**
 * Timezone-aware date helpers.
 *
 * Uses configured IANA timezone (e.g. "Europe/Warsaw") or auto-detects from system.
 * Call setTimezone() once at startup with the config value.
 */

let configuredTz: string | undefined;

/** Set the timezone from config. Call once at startup. */
export function setTimezone(tz?: string): void {
  configuredTz = tz;
}

/** Get effective timezone: config > system auto-detect > undefined (= runtime default). */
export function getTimezone(): string | undefined {
  if (configuredTz) return configuredTz;
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Extract date parts from a Date in the configured timezone. */
function partsInTz(date: Date): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const tz = getTimezone();
  if (!tz) {
    // Fallback to local runtime (same as getHours/getDate)
    return {
      year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate(),
      hour: date.getHours(), minute: date.getMinutes(), second: date.getSeconds(),
    };
  }
  // Intl.DateTimeFormat with explicit timezone gives us the correct local parts
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map(p => [p.type, p.value]));
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second),
  };
}

/** Returns date as YYYY-MM-DD in configured timezone. */
export function localDate(date: Date = new Date()): string {
  const p = partsInTz(date);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** Returns timestamp as YYYY-MM-DD HH:MM:SS in configured timezone. */
export function localTimestamp(date: Date = new Date()): string {
  const p = partsInTz(date);
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}
