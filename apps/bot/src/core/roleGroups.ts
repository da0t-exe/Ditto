import type { Guild, Role } from 'discord.js';

/** A role whose name starts with a line (━ ─ ═ ▬) is the title of every role below it. */
export const isSeparator = (role: Role) => /^[━─═▬]/.test(role.name);

export interface RoleGroup {
  separator: Role;
  roles: Role[];
}

/** Splits the role list into tiers, top to bottom. */
export function roleGroups(guild: Guild): RoleGroup[] {
  const sorted = [...guild.roles.cache.values()]
    .filter((r) => r.id !== guild.id)
    .sort((a, b) => b.position - a.position);

  const groups: RoleGroup[] = [];
  let current: RoleGroup | null = null;
  for (const role of sorted) {
    if (isSeparator(role)) {
      current = { separator: role, roles: [] };
      groups.push(current);
    } else if (current) {
      current.roles.push(role);
    }
  }
  return groups;
}
