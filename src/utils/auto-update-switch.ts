/**
 * Emergency brake for scheduled updates.
 *
 * When something is already on fire, the last thing anyone wants is the cron
 * pulling new code into the incident. `JANUS_NO_AUTO_UPDATE=1` in the gateway's
 * environment stops the scheduled check; a human asking for an update in chat
 * still works, because that is a deliberate act.
 */
const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

export function autoUpdateDisabled(env: Record<string, string | undefined>): boolean {
  const raw = env.JANUS_NO_AUTO_UPDATE;
  return !!raw && TRUTHY.has(raw.trim().toLowerCase());
}
