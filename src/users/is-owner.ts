/**
 * Is this sender allowed to run operator commands?
 *
 * Commands like `/model` and `/provider` change behaviour for every chat on the
 * instance, so in a shared household they belong to the owner alone. Mirrors
 * the ownership rule the agent loop applies to owner-only tools: explicit
 * `ownerIds`, else the first configured user; with no users configured at all
 * (single-user CLI) there is nobody to protect against.
 */
export function isOwner(
  userId: string | undefined,
  config: { ownerIds: string[]; users: { id: string }[] },
): boolean {
  if (config.users.length === 0) return true;

  const owners = config.ownerIds.length > 0 ? config.ownerIds : [config.users[0].id];
  return !!userId && owners.includes(userId);
}
