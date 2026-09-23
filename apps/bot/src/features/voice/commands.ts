import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type GuildMember,
  type VoiceBasedChannel,
} from 'discord.js';
import { getConfig } from '../../core/config.js';
import { guildLang, loc, tr, userLang } from '../../core/i18n.js';
import { logTo } from '../../core/logs.js';
import { canModerateVoice, requireVoiceMod } from '../../core/perms.js';
import type { Command, ComponentHandler } from '../../core/types.js';
import { COLOR, embed, ok, pool, replyError, sleep } from '../../core/ui.js';
import { humans, movableChannels, moveByCommand, shuffle, VOICE_TYPES } from './util.js';

const MOD = PermissionFlagsBits.MoveMembers;

async function moveAll(members: GuildMember[], to: VoiceBasedChannel | null) {
  let moved = 0;
  await pool(members, 5, async (m) => {
    try {
      await moveByCommand(m, to);
      moved++;
    } catch {
      /* left in the meantime, or channel out of reach */
    }
  });
  return moved;
}

// ---------- /move ----------

const move: Command = {
  data: loc(new SlashCommandBuilder(), 'move', ['Move members to a voice channel', 'Déplacer des membres vers un salon vocal'])
    .setDefaultMemberPermissions(MOD)
    .addChannelOption((o) =>
      loc(o, ['to', 'vers'], ['Destination channel', 'Salon de destination']).addChannelTypes(...VOICE_TYPES).setRequired(true)
    )
    .addUserOption((o) => loc(o, ['member', 'membre'], ['Only this member', 'Seulement ce membre']))
    .addRoleOption((o) => loc(o, 'role', ['Everyone in voice with this role', 'Tous les membres en vocal qui ont ce rôle']))
    .addChannelOption((o) =>
      loc(o, ['from', 'depuis'], ['This whole channel (default: yours)', 'Tout ce salon (par défaut : le tien)']).addChannelTypes(...VOICE_TYPES)
    ),
  async run(i) {
    if (!(await requireVoiceMod(i))) return;
    const lang = userLang(i);
    const to = i.options.getChannel('to', true, [...VOICE_TYPES]);
    const member = i.options.getMember('member');
    const role = i.options.getRole('role');
    const from = i.options.getChannel('from', false, [...VOICE_TYPES]) ?? i.member.voice.channel;

    let targets: GuildMember[];
    if (member) {
      if (!member.voice.channel) return replyError(i, tr(lang, `${member} is not in voice.`, `${member} n'est pas en vocal.`));
      targets = [member];
    } else if (role) {
      targets = i.guild.voiceStates.cache.map((v) => v.member).filter((m): m is GuildMember => !!m?.roles.cache.has(role.id));
    } else if (from) {
      targets = [...from.members.values()];
    } else {
      return replyError(
        i,
        tr(lang, 'Pick a member, a role or a channel to move from (or join a voice channel).', 'Précise un membre, un rôle ou un salon de départ (ou rejoins un salon vocal).')
      );
    }
    targets = targets.filter((m) => m.voice.channelId !== to.id);
    if (!targets.length) return replyError(i, tr(lang, 'Nobody to move.', 'Personne à déplacer.'));

    await i.deferReply();
    const moved = await moveAll(targets, to);
    const by = i.user.username;
    logTo(i.guild, `🔀 **${by}** moved ${moved} member(s) to ${to}`, `🔀 **${by}** a déplacé ${moved} membre(s) vers ${to}`);
    return i.editReply({
      embeds: [ok(tr(lang, `${moved}/${targets.length} member(s) moved to ${to}.`, `${moved}/${targets.length} membre(s) déplacé(s) vers ${to}.`))],
    });
  },
};

// ---------- /gather ----------

const gatherRuns = new Map<string, { origins: Map<string, string>; to: string; expires: number }>();

const gather: Command = {
  data: loc(new SlashCommandBuilder(), 'gather', ['Pull everyone in voice into one channel', 'Rassembler tous les membres en vocal dans un salon'])
    .setDefaultMemberPermissions(MOD)
    .addChannelOption((o) =>
      loc(o, ['to', 'vers'], ['Where to gather everyone', 'Salon de rassemblement']).addChannelTypes(...VOICE_TYPES).setRequired(true)
    ),
  async run(i) {
    if (!(await requireVoiceMod(i))) return;
    const lang = userLang(i);
    const to = i.options.getChannel('to', true, [...VOICE_TYPES]);
    const targets = i.guild.voiceStates.cache
      .filter((v) => v.channelId && v.channelId !== to.id && v.channelId !== i.guild.afkChannelId && v.member && !v.member.user.bot)
      .map((v) => v.member!);
    if (!targets.length) return replyError(i, tr(lang, 'Nobody to gather.', 'Personne à rassembler.'));

    await i.deferReply();
    const origins = new Map(targets.map((m) => [m.id, m.voice.channelId!]));
    const moved = await moveAll(targets, to);
    gatherRuns.set(i.id, { origins, to: to.id, expires: Date.now() + 3 * 3600_000 });

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`gather:back:${i.id}`)
        .setLabel(tr(guildLang(i.guild), 'Send everyone back', 'Renvoyer chacun chez soi'))
        .setEmoji('↩️')
        .setStyle(ButtonStyle.Secondary)
    );
    const by = i.user.username;
    logTo(i.guild, `📣 **${by}** gathered ${moved} member(s) in ${to}`, `📣 **${by}** a rassemblé ${moved} membre(s) dans ${to}`);
    return i.editReply({
      embeds: [ok(tr(lang, `${moved} member(s) gathered in ${to}.`, `${moved} membre(s) rassemblé(s) dans ${to}.`))],
      components: [row],
    });
  },
};

export const gatherBack: ComponentHandler = async (i, [action, runId]) => {
  if (action !== 'back' || !(await requireVoiceMod(i))) return;
  const run = gatherRuns.get(runId);
  if (!run || run.expires < Date.now()) return i.update({ components: [] });
  gatherRuns.delete(runId);
  await i.deferUpdate();
  let back = 0;
  await pool([...run.origins], 5, async ([memberId, channelId]) => {
    const member = i.guild.members.cache.get(memberId);
    const channel = i.guild.channels.cache.get(channelId);
    if (!member || member.voice.channelId !== run.to || !channel?.isVoiceBased()) return;
    try {
      await moveByCommand(member, channel);
      back++;
    } catch {
      /* ignore */
    }
  });
  const lang = guildLang(i.guild);
  return i.editReply({
    embeds: [ok(tr(lang, `${back} member(s) sent back to their channel.`, `${back} membre(s) renvoyé(s) dans leur salon.`))],
    components: [],
  });
};

// ---------- /split ----------

const split: Command = {
  data: loc(new SlashCommandBuilder(), 'split', ['Shuffle a channel into random teams', 'Répartir un salon en équipes au hasard'])
    .setDefaultMemberPermissions(MOD)
    .addIntegerOption((o) => loc(o, ['teams', 'equipes'], ['Number of teams', "Nombre d'équipes"]).setMinValue(2).setMaxValue(4).setRequired(true))
    .addChannelOption((o) =>
      loc(o, ['from', 'depuis'], ['Channel to split (default: yours)', 'Salon à répartir (par défaut : le tien)']).addChannelTypes(...VOICE_TYPES)
    ),
  async run(i) {
    if (!(await requireVoiceMod(i))) return;
    const lang = userLang(i);
    const count = i.options.getInteger('teams', true);
    const from = i.options.getChannel('from', false, [...VOICE_TYPES]) ?? i.member.voice.channel;
    if (!from) return replyError(i, tr(lang, 'Join a voice channel or set `from`.', 'Rejoins un salon vocal ou précise `depuis`.'));

    const players = shuffle(humans(from));
    if (players.length < count) {
      return replyError(i, tr(lang, `${from} needs at least ${count} people.`, `Il faut au moins ${count} personnes dans ${from}.`));
    }

    const cfg = getConfig(i.guildId);
    const candidates = movableChannels(i.guild).filter(
      (c) => c.id !== from.id && c.members.size === 0 && (cfg.rooms.length ? cfg.rooms.includes(c.id) : c.parentId === from.parentId)
    );
    const channels = [from, ...candidates.slice(0, count - 1)];
    if (channels.length < count) {
      return replyError(i, tr(lang, `Not enough empty channels for ${count} teams.`, `Pas assez de salons vides pour ${count} équipes.`));
    }

    await i.deferReply();
    const teams = channels.map((channel, k) => ({ channel, members: players.filter((_, idx) => idx % count === k) }));
    for (const team of teams.slice(1)) await moveAll(team.members, team.channel);

    const e = new EmbedBuilder()
      .setColor(COLOR.primary)
      .setTitle(tr(lang, `🎲 ${count} teams`, `🎲 ${count} équipes`))
      .addFields(
        teams.map((t, k) => ({
          name: `${tr(lang, 'Team', 'Équipe')} ${k + 1} — ${t.channel.name}`,
          value: t.members.map(String).join('\n') || '—',
          inline: true,
        }))
      );
    const by = i.user.username;
    logTo(i.guild, `🎲 **${by}** split ${from} into ${count} teams`, `🎲 **${by}** a réparti ${from} en ${count} équipes`);
    return i.editReply({ embeds: [e], allowedMentions: { parse: [] } });
  },
};

// ---------- /disconnect ----------

const disconnect: Command = {
  data: loc(new SlashCommandBuilder(), 'disconnect', ['Disconnect a member or a whole channel from voice', 'Déconnecter du vocal un membre ou tout un salon'])
    .setDefaultMemberPermissions(MOD)
    .addUserOption((o) => loc(o, ['member', 'membre'], ['This member', 'Ce membre']))
    .addChannelOption((o) => loc(o, ['channel', 'salon'], ['This whole channel', 'Tout ce salon']).addChannelTypes(...VOICE_TYPES)),
  async run(i) {
    if (!(await requireVoiceMod(i))) return;
    const lang = userLang(i);
    const member = i.options.getMember('member');
    const channel = i.options.getChannel('channel', false, [...VOICE_TYPES]);
    const targets = member ? (member.voice.channel ? [member] : []) : channel ? humans(channel) : null;
    if (targets === null) return replyError(i, tr(lang, 'Pick a member or a channel.', 'Précise un membre ou un salon.'));
    if (!targets.length) return replyError(i, tr(lang, 'Nobody to disconnect.', 'Personne à déconnecter.'));

    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const done = await moveAll(targets, null);
    const by = i.user.username;
    const where = channel ? ` ${tr(guildLang(i.guild), 'from', 'de')} ${channel}` : '';
    logTo(i.guild, `🔌 **${by}** disconnected ${done} member(s)${where}`, `🔌 **${by}** a déconnecté ${done} membre(s)${where}`);
    return i.editReply({ embeds: [ok(tr(lang, `${done} member(s) disconnected.`, `${done} membre(s) déconnecté(s).`))] });
  },
};

// ---------- /shake ----------

const shakeRuns = new Map<string, { cancelled: boolean; by: string }>();

const shake: Command = {
  data: loc(new SlashCommandBuilder(), 'shake', ['Bounce a member through random channels to wake them up', 'Secouer un membre à travers les salons pour le réveiller'])
    .setDefaultMemberPermissions(MOD)
    .addUserOption((o) => loc(o, ['member', 'membre'], ['Member to wake up', 'Membre à réveiller']).setRequired(true))
    .addIntegerOption((o) =>
      loc(o, ['times', 'coups'], ['Number of moves (default 10)', 'Nombre de déplacements (10 par défaut)']).setMinValue(1).setMaxValue(30)
    )
    .addChannelOption((o) =>
      loc(o, ['to', 'vers'], ['Where to drop them at the end (default: where they were)', 'Où le déposer à la fin (par défaut : là où il était)']).addChannelTypes(
        ...VOICE_TYPES
      )
    ),
  async run(i) {
    if (!(await requireVoiceMod(i))) return;
    const lang = userLang(i);
    const target = i.options.getMember('member');
    if (!target?.voice.channel) return replyError(i, tr(lang, 'This member is not in voice.', "Ce membre n'est pas en vocal."));
    const hits = i.options.getInteger('times') ?? 10;
    const origin = target.voice.channel;
    const finalChannel = i.options.getChannel('to', false, [...VOICE_TYPES]) ?? origin;
    const channels = movableChannels(i.guild);
    if (channels.length < 2) return replyError(i, tr(lang, 'Not enough voice channels I can use.', 'Pas assez de salons vocaux accessibles.'));

    const run = { cancelled: false, by: i.user.id };
    shakeRuns.set(i.id, run);
    const stopRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`shake:stop:${i.id}`).setLabel('Stop').setEmoji('✋').setStyle(ButtonStyle.Danger)
    );
    const title = tr(lang, `🫨 Waking up ${target.displayName}`, `🫨 Réveil de ${target.displayName}`);
    const progress = (n: number) => embed(COLOR.warn, tr(lang, `Shake ${n}/${hits}…`, `Secousse ${n}/${hits}…`), title);
    await i.reply({ embeds: [progress(0)], components: [stopRow] });

    let moved = 0;
    let error: string | null = null;
    let lastEdit = Date.now();
    for (let n = 0; n < hits && !run.cancelled; n++) {
      if (!target.voice.channelId) break;
      const options = channels.filter((c) => c.id !== target.voice.channelId);
      try {
        await moveByCommand(target, options[Math.floor(Math.random() * options.length)]);
        moved++;
      } catch (err) {
        error = (err as Error).message;
        break;
      }
      if (Date.now() - lastEdit > 2000) {
        lastEdit = Date.now();
        await i.editReply({ embeds: [progress(moved)] }).catch(() => {});
      }
      await sleep(700);
    }
    if (target.voice.channelId && target.voice.channelId !== finalChannel.id) {
      await moveByCommand(target, finalChannel).catch(() => {});
    }
    shakeRuns.delete(i.id);

    const doneTitle = run.cancelled
      ? tr(lang, '✋ Stopped', '✋ Réveil arrêté')
      : error
        ? tr(lang, '⚠️ Interrupted', '⚠️ Réveil interrompu')
        : tr(lang, '✅ Done', '✅ Réveil terminé');
    const text =
      tr(lang, `${target} was shaken ${moved} time(s), then dropped in ${finalChannel}.`, `${target} a été secoué ${moved} fois, puis déposé dans ${finalChannel}.`) +
      (error ? `\n${error}` : '');
    const by = i.user.username;
    const who = target.user.username;
    logTo(i.guild, `🫨 **${by}** shook **${who}** (${moved} times)`, `🫨 **${by}** a secoué **${who}** (${moved} fois)`);
    return i.editReply({ embeds: [embed(error ? COLOR.warn : COLOR.success, text, doneTitle)], components: [] });
  },
};

export const shakeStop: ComponentHandler = async (i, [action, runId]) => {
  const run = shakeRuns.get(runId);
  if (action !== 'stop' || !run) return i.deferUpdate();
  if (run.by !== i.user.id && !canModerateVoice(i.member)) {
    return replyError(i, tr(userLang(i), 'Only staff can stop this.', 'Seul le staff peut arrêter.'));
  }
  run.cancelled = true;
  return i.deferUpdate();
};

export const voiceCommands = [move, gather, split, disconnect, shake];
