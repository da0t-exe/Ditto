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
      /* membre parti entre-temps, ou salon inaccessible */
    }
  });
  return moved;
}

// ---------- /move ----------

const move: Command = {
  data: new SlashCommandBuilder()
    .setName('move')
    .setDescription('Déplacer des membres vers un salon vocal')
    .setDefaultMemberPermissions(MOD)
    .addChannelOption((o) => o.setName('vers').setDescription('Salon de destination').addChannelTypes(...VOICE_TYPES).setRequired(true))
    .addUserOption((o) => o.setName('membre').setDescription('Seulement ce membre'))
    .addRoleOption((o) => o.setName('role').setDescription('Tous les membres en vocal qui ont ce rôle'))
    .addChannelOption((o) =>
      o.setName('depuis').setDescription('Tout ce salon (par défaut : le tien)').addChannelTypes(...VOICE_TYPES)
    ),
  async run(i) {
    if (!(await requireVoiceMod(i))) return;
    const to = i.options.getChannel('vers', true, [...VOICE_TYPES]);
    const member = i.options.getMember('membre');
    const role = i.options.getRole('role');
    const from = i.options.getChannel('depuis', false, [...VOICE_TYPES]) ?? i.member.voice.channel;

    let targets: GuildMember[];
    if (member) {
      if (!member.voice.channel) return replyError(i, `${member} n'est pas en vocal.`);
      targets = [member];
    } else if (role) {
      targets = i.guild.voiceStates.cache.map((v) => v.member).filter((m): m is GuildMember => !!m?.roles.cache.has(role.id));
    } else if (from) {
      targets = [...from.members.values()];
    } else {
      return replyError(i, 'Précise un membre, un rôle ou un salon de départ (ou rejoins un salon vocal).');
    }
    targets = targets.filter((m) => m.voice.channelId !== to.id);
    if (!targets.length) return replyError(i, 'Personne à déplacer.');

    await i.deferReply();
    const moved = await moveAll(targets, to);
    logTo(i.guild, `🔀 **${i.user.username}** a déplacé ${moved} membre(s) vers ${to}`);
    return i.editReply({ embeds: [ok(`${moved}/${targets.length} membre(s) déplacé(s) vers ${to}.`)] });
  },
};

// ---------- /gather ----------

const gatherRuns = new Map<string, { origins: Map<string, string>; to: string; expires: number }>();

const gather: Command = {
  data: new SlashCommandBuilder()
    .setName('gather')
    .setDescription('Rassembler tous les membres en vocal dans un salon')
    .setDefaultMemberPermissions(MOD)
    .addChannelOption((o) => o.setName('vers').setDescription('Salon de rassemblement').addChannelTypes(...VOICE_TYPES).setRequired(true)),
  async run(i) {
    if (!(await requireVoiceMod(i))) return;
    const to = i.options.getChannel('vers', true, [...VOICE_TYPES]);
    const targets = i.guild.voiceStates.cache
      .filter((v) => v.channelId && v.channelId !== to.id && v.channelId !== i.guild.afkChannelId && v.member && !v.member.user.bot)
      .map((v) => v.member!);
    if (!targets.length) return replyError(i, 'Personne à rassembler.');

    await i.deferReply();
    const origins = new Map(targets.map((m) => [m.id, m.voice.channelId!]));
    const moved = await moveAll(targets, to);
    gatherRuns.set(i.id, { origins, to: to.id, expires: Date.now() + 3 * 3600_000 });

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`gather:back:${i.id}`).setLabel('Renvoyer chacun chez soi').setEmoji('↩️').setStyle(ButtonStyle.Secondary)
    );
    logTo(i.guild, `📣 **${i.user.username}** a rassemblé ${moved} membre(s) dans ${to}`);
    return i.editReply({ embeds: [ok(`${moved} membre(s) rassemblé(s) dans ${to}.`)], components: [row] });
  },
};

export const gatherBack: ComponentHandler = async (i, [action, runId]) => {
  if (action !== 'back' || !(await requireVoiceMod(i))) return;
  const run = gatherRuns.get(runId);
  if (!run || run.expires < Date.now()) {
    return i.update({ components: [] });
  }
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
  return i.editReply({ embeds: [ok(`${back} membre(s) renvoyé(s) dans leur salon.`)], components: [] });
};

// ---------- /split ----------

const split: Command = {
  data: new SlashCommandBuilder()
    .setName('split')
    .setDescription('Répartir un salon en équipes au hasard')
    .setDefaultMemberPermissions(MOD)
    .addIntegerOption((o) => o.setName('equipes').setDescription("Nombre d'équipes").setMinValue(2).setMaxValue(4).setRequired(true))
    .addChannelOption((o) => o.setName('depuis').setDescription('Salon à répartir (par défaut : le tien)').addChannelTypes(...VOICE_TYPES)),
  async run(i) {
    if (!(await requireVoiceMod(i))) return;
    const count = i.options.getInteger('equipes', true);
    const from = i.options.getChannel('depuis', false, [...VOICE_TYPES]) ?? i.member.voice.channel;
    if (!from) return replyError(i, 'Rejoins un salon vocal ou précise `depuis`.');

    const players = shuffle(humans(from));
    if (players.length < count) return replyError(i, `Il faut au moins ${count} personnes dans ${from}.`);

    const cfg = getConfig(i.guildId);
    const candidates = movableChannels(i.guild).filter(
      (c) => c.id !== from.id && c.members.size === 0 && (cfg.rooms.length ? cfg.rooms.includes(c.id) : c.parentId === from.parentId)
    );
    const channels = [from, ...candidates.slice(0, count - 1)];
    if (channels.length < count) return replyError(i, `Pas assez de salons vides pour ${count} équipes.`);

    await i.deferReply();
    const teams = channels.map((channel, k) => ({ channel, members: players.filter((_, idx) => idx % count === k) }));
    for (const team of teams.slice(1)) await moveAll(team.members, team.channel);

    const e = new EmbedBuilder()
      .setColor(COLOR.primary)
      .setTitle(`🎲 ${count} équipes`)
      .addFields(teams.map((t, k) => ({ name: `Équipe ${k + 1} — ${t.channel.name}`, value: t.members.map(String).join('\n') || '—', inline: true })));
    logTo(i.guild, `🎲 **${i.user.username}** a réparti ${from} en ${count} équipes`);
    return i.editReply({ embeds: [e], allowedMentions: { parse: [] } });
  },
};

// ---------- /disconnect ----------

const disconnect: Command = {
  data: new SlashCommandBuilder()
    .setName('disconnect')
    .setDescription('Déconnecter du vocal un membre ou tout un salon')
    .setDefaultMemberPermissions(MOD)
    .addUserOption((o) => o.setName('membre').setDescription('Ce membre'))
    .addChannelOption((o) => o.setName('salon').setDescription('Tout ce salon').addChannelTypes(...VOICE_TYPES)),
  async run(i) {
    if (!(await requireVoiceMod(i))) return;
    const member = i.options.getMember('membre');
    const channel = i.options.getChannel('salon', false, [...VOICE_TYPES]);
    const targets = member ? (member.voice.channel ? [member] : []) : channel ? humans(channel) : null;
    if (targets === null) return replyError(i, 'Précise un membre ou un salon.');
    if (!targets.length) return replyError(i, 'Personne à déconnecter.');

    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const done = await moveAll(targets, null);
    logTo(i.guild, `🔌 **${i.user.username}** a déconnecté ${done} membre(s)${channel ? ` de ${channel}` : ''}`);
    return i.editReply({ embeds: [ok(`${done} membre(s) déconnecté(s).`)] });
  },
};

// ---------- /shake ----------

const shakeRuns = new Map<string, { cancelled: boolean; by: string }>();

const shake: Command = {
  data: new SlashCommandBuilder()
    .setName('shake')
    .setDescription('Secouer un membre à travers les salons pour le réveiller')
    .setDefaultMemberPermissions(MOD)
    .addUserOption((o) => o.setName('membre').setDescription('Membre à réveiller').setRequired(true))
    .addIntegerOption((o) => o.setName('coups').setDescription('Nombre de déplacements (10 par défaut)').setMinValue(1).setMaxValue(30))
    .addChannelOption((o) =>
      o.setName('vers').setDescription('Où le déposer à la fin (par défaut : là où il était)').addChannelTypes(...VOICE_TYPES)
    ),
  async run(i) {
    if (!(await requireVoiceMod(i))) return;
    const target = i.options.getMember('membre');
    if (!target?.voice.channel) return replyError(i, "Ce membre n'est pas en vocal.");
    const hits = i.options.getInteger('coups') ?? 10;
    const origin = target.voice.channel;
    const finalChannel = i.options.getChannel('vers', false, [...VOICE_TYPES]) ?? origin;
    const channels = movableChannels(i.guild);
    if (channels.length < 2) return replyError(i, 'Pas assez de salons vocaux accessibles.');

    const run = { cancelled: false, by: i.user.id };
    shakeRuns.set(i.id, run);
    const stopRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`shake:stop:${i.id}`).setLabel('Stop').setEmoji('✋').setStyle(ButtonStyle.Danger)
    );
    const progress = (n: number) => embed(COLOR.warn, `Secousse ${n}/${hits}…`, `🫨 Réveil de ${target.displayName}`);
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

    const title = run.cancelled ? '✋ Réveil arrêté' : error ? '⚠️ Réveil interrompu' : '✅ Réveil terminé';
    const text = `${target} a été secoué ${moved} fois, puis déposé dans ${finalChannel}.${error ? `\n${error}` : ''}`;
    logTo(i.guild, `🫨 **${i.user.username}** a secoué **${target.user.username}** (${moved} fois)`);
    return i.editReply({ embeds: [embed(error ? COLOR.warn : COLOR.success, text, title)], components: [] });
  },
};

export const shakeStop: ComponentHandler = async (i, [action, runId]) => {
  const run = shakeRuns.get(runId);
  if (action !== 'stop' || !run) return i.deferUpdate();
  if (run.by !== i.user.id && !canModerateVoice(i.member)) return replyError(i, 'Seul le staff peut arrêter.');
  run.cancelled = true;
  return i.deferUpdate();
};

export const voiceCommands = [move, gather, split, disconnect, shake];
