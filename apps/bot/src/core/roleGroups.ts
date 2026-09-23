import type { Guild, Role } from 'discord.js';

/** Un rôle dont le nom commence par « ━ » sert de titre à tous les rôles placés sous lui. */
export const isSeparator = (role: Role) => role.name.startsWith('━');

export interface RoleGroup {
  separator: Role;
  roles: Role[];
}

/** Découpe la liste des rôles en étages, du haut vers le bas. */
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
