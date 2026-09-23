import { Events, MessageFlags, SlashCommandBuilder, type GuildMember } from 'discord.js';
import { getConfig } from '../../core/config.js';
import { loc, tr, userLang } from '../../core/i18n.js';
import { log } from '../../core/log.js';
import { isPrivileged } from '../../core/perms.js';
import { roleGroups } from '../../core/roleGroups.js';
import type { Feature } from '../../core/types.js';
import { ok, replyError } from '../../core/ui.js';
import { applyChoice, pickerView } from './picker.js';

/**
 * Tier titles (« ━━━ 🎮 Games ━━━ »): a member holds a tier's title only while
 * they hold at least one role of that tier, so profiles never show empty headings.
 */
async function syncSeparators(member: GuildMember) {
  const me = member.guild.members.me;
  if (!me) return false;
  const add: string[] = [];
  const remove: string[] = [];
  for (const g of roleGroups(member.guild)) {
    if (me.roles.highest.comparePositionTo(g.separator) <= 0) continue; // out of the bot's reach
    const hasGroup = g.roles.some((r) => member.roles.cache.has(r.id));
    const hasSep = member.roles.cache.has(g.separator.id);
    if (hasGroup && !hasSep) add.push(g.separator.id);
    if (!hasGroup && hasSep) remove.push(g.separator.id);
  }
  if (add.length) await member.roles.add(add, 'Tier titles');
  if (remove.length) await member.roles.remove(remove, 'Tier titles');
  return add.length + remove.length > 0;
}

export const rolesFeature: Feature = {
  name: 'roles',

  commands: [
    {
      data: loc(new SlashCommandBuilder(), 'roles', ['Pick your colour and your games', 'Choisir ta couleur et tes jeux']),
      async run(i) {
        const cfg = getConfig(i.guildId);
        const lang = userLang(i);
        if (cfg.memberRole && !i.member.roles.cache.has(cfg.memberRole) && !isPrivileged(i.member)) {
          return replyError(i, tr(lang, 'Verify yourself first in the verification channel.', "Vérifie-toi d'abord dans le salon de vérification."));
        }
        return i.reply({ ...pickerView(i.member, lang), flags: MessageFlags.Ephemeral });
      },
    },
  ],

  components: {
    async roles(i, [action]) {
      const cfg = getConfig(i.guildId);
      const lang = userLang(i);
      if (action === 'done') {
        return i.update({
          embeds: [ok(tr(lang, 'All set! Change them any time with **/roles**.', 'C’est tout bon ! Tu peux changer à tout moment avec **/roles**.'))],
          components: [],
        });
      }
      if (!i.isStringSelectMenu()) return;
      const pool = action === 'color' ? cfg.colorRoles : cfg.gameRoles;
      const member = await applyChoice(i.member, pool, i.values);
      return i.update(pickerView(member, lang));
    },
  },

  init(client) {
    client.on(Events.GuildMemberUpdate, (oldMember, newMember) => {
      const same =
        oldMember.roles.cache.size === newMember.roles.cache.size &&
        oldMember.roles.cache.every((_, id) => newMember.roles.cache.has(id));
      if (same) return;
      syncSeparators(newMember).catch((err) => log.warn('roles', err.message));
    });
  },

  async guildReady(guild) {
    let changed = 0;
    for (const member of guild.members.cache.values()) {
      if (await syncSeparators(member).catch(() => false)) changed++;
    }
    if (changed) log.info('roles', `${guild.name}: tier titles fixed on ${changed} member(s)`);
  },
};
