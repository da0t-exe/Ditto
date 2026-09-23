import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type GuildMember,
  type Role,
} from 'discord.js';
import { getConfig } from '../../core/config.js';
import { COLOR, embed, splitEmoji } from '../../core/ui.js';

function options(roles: Role[], member: GuildMember) {
  return roles.map((r) => {
    const { emoji, label } = splitEmoji(r.name);
    const o = new StringSelectMenuOptionBuilder().setLabel(label).setValue(r.id).setDefault(member.roles.cache.has(r.id));
    if (emoji) o.setEmoji(emoji);
    return o;
  });
}

/** Menu de personnalisation : une couleur, et les jeux (plusieurs possibles). */
export function pickerView(member: GuildMember, intro?: string) {
  const cfg = getConfig(member.guild.id);
  const resolve = (ids: string[]) => ids.map((id) => member.guild.roles.cache.get(id)).filter((r): r is Role => !!r);
  const colors = resolve(cfg.colorRoles);
  const games = resolve(cfg.gameRoles);

  const rows: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] = [];
  if (colors.length) {
    rows.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('roles:color')
          .setPlaceholder('🎨 Choisis ta couleur')
          .setMinValues(0)
          .setMaxValues(1)
          .addOptions(options(colors, member))
      )
    );
  }
  if (games.length) {
    rows.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('roles:games')
          .setPlaceholder('🎮 À quoi tu joues ?')
          .setMinValues(0)
          .setMaxValues(games.length)
          .addOptions(options(games, member))
      )
    );
  }
  rows.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('roles:done').setLabel('Terminé').setStyle(ButtonStyle.Success)
    )
  );

  const lines = [
    intro,
    'Choisis la couleur de ton pseudo et les jeux auxquels tu joues.',
    'Tu pourras changer à tout moment avec **/roles**.',
  ].filter(Boolean);
  return { embeds: [embed(COLOR.primary, lines.join('\n'), '🎨 Personnalise ton profil')], components: rows };
}

/** Garde exactement `selected` parmi `pool` sur ce membre. */
export async function applyChoice(member: GuildMember, pool: string[], selected: string[]) {
  const add = selected.filter((id) => pool.includes(id) && !member.roles.cache.has(id));
  const remove = pool.filter((id) => member.roles.cache.has(id) && !selected.includes(id));
  if (remove.length) member = await member.roles.remove(remove, 'Choix de rôles');
  if (add.length) member = await member.roles.add(add, 'Choix de rôles');
  return member;
}
