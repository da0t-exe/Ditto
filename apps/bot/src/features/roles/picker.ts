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
import { tr, type Lang } from '../../core/i18n.js';
import { COLOR, embed, splitEmoji } from '../../core/ui.js';

function options(roles: Role[], member: GuildMember) {
  return roles.map((r) => {
    const { emoji, label } = splitEmoji(r.name);
    const o = new StringSelectMenuOptionBuilder().setLabel(label).setValue(r.id).setDefault(member.roles.cache.has(r.id));
    if (emoji) o.setEmoji(emoji);
    return o;
  });
}

/** Profile menu: one colour, and any number of games. */
export function pickerView(member: GuildMember, lang: Lang, intro?: string) {
  const cfg = getConfig(member.guild.id);
  const resolve = (ids: string[]) => ids.map((id) => member.guild.roles.cache.get(id)).filter((r): r is Role => !!r);
  const colors = resolve(cfg.colorRoles).slice(0, 25);
  const games = resolve(cfg.gameRoles).slice(0, 25);

  const rows: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] = [];
  if (colors.length) {
    rows.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('roles:color')
          .setPlaceholder(tr(lang, '🎨 Pick your colour', '🎨 Choisis ta couleur'))
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
          .setPlaceholder(tr(lang, '🎮 What do you play?', '🎮 À quoi tu joues ?'))
          .setMinValues(0)
          .setMaxValues(games.length)
          .addOptions(options(games, member))
      )
    );
  }
  rows.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('roles:done').setLabel(tr(lang, 'Done', 'Terminé')).setStyle(ButtonStyle.Success)
    )
  );

  const body =
    colors.length || games.length
      ? tr(
          lang,
          'Pick the colour of your name and the games you play.\nYou can change them any time with **/roles**.',
          'Choisis la couleur de ton pseudo et les jeux auxquels tu joues.\nTu pourras changer à tout moment avec **/roles**.'
        )
      : tr(lang, 'Nothing to pick on this server yet.', 'Rien à choisir sur ce serveur pour l’instant.');
  const title = tr(lang, '🎨 Your profile', '🎨 Personnalise ton profil');
  return { embeds: [embed(COLOR.primary, [intro, body].filter(Boolean).join('\n'), title)], components: rows };
}

/** Keeps exactly `selected` out of `pool` on this member. */
export async function applyChoice(member: GuildMember, pool: string[], selected: string[]) {
  const add = selected.filter((id) => pool.includes(id) && !member.roles.cache.has(id));
  const remove = pool.filter((id) => member.roles.cache.has(id) && !selected.includes(id));
  if (remove.length) member = await member.roles.remove(remove, 'Role picker');
  if (add.length) member = await member.roles.add(add, 'Role picker');
  return member;
}
