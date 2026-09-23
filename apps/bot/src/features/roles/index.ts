import { Events, MessageFlags, SlashCommandBuilder, type GuildMember } from 'discord.js';
import { getConfig } from '../../core/config.js';
import { log } from '../../core/log.js';
import { isPrivileged } from '../../core/perms.js';
import { roleGroups } from '../../core/roleGroups.js';
import type { Feature } from '../../core/types.js';
import { ok, replyError } from '../../core/ui.js';
import { applyChoice, pickerView } from './picker.js';

/**
 * Rôles-titres (« ━━━ 🎮 Jeux ━━━ ») : un membre porte le titre d'un étage
 * seulement s'il a au moins un rôle de cet étage. Le profil reste propre.
 */
async function syncSeparators(member: GuildMember) {
  const me = member.guild.members.me;
  if (!me) return;
  const add: string[] = [];
  const remove: string[] = [];
  for (const g of roleGroups(member.guild)) {
    if (me.roles.highest.comparePositionTo(g.separator) <= 0) continue; // hors de portée du bot
    const hasGroup = g.roles.some((r) => member.roles.cache.has(r.id));
    const hasSep = member.roles.cache.has(g.separator.id);
    if (hasGroup && !hasSep) add.push(g.separator.id);
    if (!hasGroup && hasSep) remove.push(g.separator.id);
  }
  if (add.length) await member.roles.add(add, 'Rôles-titres');
  if (remove.length) await member.roles.remove(remove, 'Rôles-titres');
  return add.length + remove.length > 0;
}

export const rolesFeature: Feature = {
  name: 'roles',

  commands: [
    {
      data: new SlashCommandBuilder().setName('roles').setDescription('Choisir ta couleur et tes jeux'),
      async run(i) {
        const cfg = getConfig(i.guildId);
        if (cfg.membersRole && !i.member.roles.cache.has(cfg.membersRole) && !isPrivileged(i.member)) {
          return replyError(i, "Vérifie-toi d'abord dans le salon de vérification.");
        }
        return i.reply({ ...pickerView(i.member), flags: MessageFlags.Ephemeral });
      },
    },
  ],

  components: {
    async roles(i, [action]) {
      const cfg = getConfig(i.guildId);
      if (action === 'done') {
        return i.update({ embeds: [ok('C’est tout bon ! Tu peux changer à tout moment avec **/roles**.')], components: [] });
      }
      if (!i.isStringSelectMenu()) return;
      const pool = action === 'color' ? cfg.colorRoles : cfg.gameRoles;
      const member = await applyChoice(i.member, pool, i.values);
      return i.update(pickerView(member));
    },
  },

  init(client) {
    client.on(Events.GuildMemberUpdate, (oldMember, newMember) => {
      if (oldMember.roles.cache.size === newMember.roles.cache.size &&
          oldMember.roles.cache.every((_, id) => newMember.roles.cache.has(id))) return;
      syncSeparators(newMember).catch((err) => log.warn('roles', err.message));
    });
  },

  async guildReady(guild) {
    let changed = 0;
    for (const member of guild.members.cache.values()) {
      if (await syncSeparators(member).catch(() => false)) changed++;
    }
    if (changed) log.info('roles', `${guild.name} : rôles-titres corrigés sur ${changed} membre(s)`);
  },
};
