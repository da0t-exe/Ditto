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
      /* left in the meantime, or channel out of reach */
    }
  });
  return moved;
}

// ---------- /move ----------

const move: Command = {
  data: new SlashCommandBuilder()
    .setName('move')
    .setDescription('Move members to a voice channel')
    .setDefaultMemberPermissions(MOD)
    .addChannelOption((o) =>
      o
        .setName('to')
        .setDescription('Destination channel')
        .addChannelTypes(...VOICE_TYPES)
        .setRequired(true)
    )
    .addUserOption((o) => o.setName('member').setDescription('Only this member'))
    .addRoleOption((o) => o.setName('role').setDescription('Everyone in voice with this role'))
    .addChannelOption((o) =>
      o
        .setName('from')
        .setDescription('This whole channel (default: yours)')
        .addChannelTypes(...VOICE_TYPES)
    ),
  async run(i) {
    if (!(await requireVoiceMod(i))) return;
    const to = i.options.getChannel('to', true, [...VOICE_TYPES]);
    const member = i.options.getMember('member');
    const role = i.options.getRole('role');
    const from = i.options.getChannel('from', false, [...VOICE_TYPES]) ?? i.member.voice.channel;

    let targets: GuildMember[];
    if (member) {
      if (!member.voice.channel) return replyError(i, `${member} is not in voice.`);
      targets = [member];
    } else if (role) {
      targets = i.guild.voiceStates.cache.map((v) => v.member).filter((m): m is GuildMember => !!m?.roles.cache.has(role.id));
    } else if (from) {
      targets = [...from.members.values()];
    } else {
      return replyError(i, 'Pick a member, a role or a channel to move from (or join a voice channel).');
    }
    targets = targets.filter((m) => m.voice.channelId !== to.id);
    if (!targets.length) return replyError(i, 'Nobody to move.');

    await i.deferReply();
    const moved = await moveAll(targets, to);
    const by = i.user.username;
    logTo(i.guild, `🔀 **${by}** moved ${moved} member(s) to ${to}`);
    return i.editReply({
      embeds: [ok(`${moved}/${targets.length} member(s) moved to ${to}.`)],
    });
  },
};

// ---------- /gather ----------

const gatherRuns = new Map<string, { origins: Map<string, string>; to: string; expires: number }>();

const gather: Command = {
  data: new SlashCommandBuilder()
    .setName('gather')
    .setDescription('Pull everyone in voice into one channel')
    .setDefaultMemberPermissions(MOD)
    .addChannelOption((o) =>
      o
        .setName('to')
        .setDescription('Where to gather everyone')
        .addChannelTypes(...VOICE_TYPES)
        .setRequired(true)
    ),
  async run(i) {
    if (!(await requireVoiceMod(i))) return;
    const to = i.options.getChannel('to', true, [...VOICE_TYPES]);
    const targets = i.guild.voiceStates.cache
      .filter((v) => v.channelId && v.channelId !== to.id && v.channelId !== i.guild.afkChannelId && v.member && !v.member.user.bot)
      .map((v) => v.member!);
    if (!targets.length) return replyError(i, 'Nobody to gather.');

    await i.deferReply();
    const origins = new Map(targets.map((m) => [m.id, m.voice.channelId!]));
    const moved = await moveAll(targets, to);
    gatherRuns.set(i.id, { origins, to: to.id, expires: Date.now() + 3 * 3600_000 });

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`gather:back:${i.id}`).setLabel('Send everyone back').setEmoji('↩️').setStyle(ButtonStyle.Secondary)
    );
    const by = i.user.username;
    logTo(i.guild, `📣 **${by}** gathered ${moved} member(s) in ${to}`);
    return i.editReply({
      embeds: [ok(`${moved} member(s) gathered in ${to}.`)],
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
  return i.editReply({
    embeds: [ok(`${back} member(s) sent back to their channel.`)],
    components: [],
  });
};

// ---------- /split ----------

const split: Command = {
  data: new SlashCommandBuilder()
    .setName('split')
    .setDescription('Shuffle a channel into random teams')
    .setDefaultMemberPermissions(MOD)
    .addIntegerOption((o) => o.setName('teams').setDescription('Number of teams').setMinValue(2).setMaxValue(4).setRequired(true))
    .addChannelOption((o) =>
      o
        .setName('from')
        .setDescription('Channel to split (default: yours)')
        .addChannelTypes(...VOICE_TYPES)
    ),
  async run(i) {
    if (!(await requireVoiceMod(i))) return;
    const count = i.options.getInteger('teams', true);
    const from = i.options.getChannel('from', false, [...VOICE_TYPES]) ?? i.member.voice.channel;
    if (!from) return replyError(i, 'Join a voice channel or set `from`.');

    const players = shuffle(humans(from));
    if (players.length < count) {
      return replyError(i, `${from} needs at least ${count} people.`);
    }

    const cfg = getConfig(i.guildId);
    const candidates = movableChannels(i.guild).filter(
      (c) => c.id !== from.id && c.members.size === 0 && (cfg.rooms.length ? cfg.rooms.includes(c.id) : c.parentId === from.parentId)
    );
    const channels = [from, ...candidates.slice(0, count - 1)];
    if (channels.length < count) {
      return replyError(i, `Not enough empty channels for ${count} teams.`);
    }

    await i.deferReply();
    const teams = channels.map((channel, k) => ({ channel, members: players.filter((_, idx) => idx % count === k) }));
    for (const team of teams.slice(1)) await moveAll(team.members, team.channel);

    const e = new EmbedBuilder()
      .setColor(COLOR.primary)
      .setTitle(`🎲 ${count} teams`)
      .addFields(
        teams.map((t, k) => ({
          name: `Team ${k + 1} — ${t.channel.name}`,
          value: t.members.map(String).join('\n') || '—',
          inline: true,
        }))
      );
    const by = i.user.username;
    logTo(i.guild, `🎲 **${by}** split ${from} into ${count} teams`);
    return i.editReply({ embeds: [e], allowedMentions: { parse: [] } });
  },
};

// ---------- /disconnect ----------

const disconnect: Command = {
  data: new SlashCommandBuilder()
    .setName('disconnect')
    .setDescription('Disconnect a member or a whole channel from voice')
    .setDefaultMemberPermissions(MOD)
    .addUserOption((o) => o.setName('member').setDescription('This member'))
    .addChannelOption((o) =>
      o
        .setName('channel')
        .setDescription('This whole channel')
        .addChannelTypes(...VOICE_TYPES)
    ),
  async run(i) {
    if (!(await requireVoiceMod(i))) return;
    const member = i.options.getMember('member');
    const channel = i.options.getChannel('channel', false, [...VOICE_TYPES]);
    const targets = member ? (member.voice.channel ? [member] : []) : channel ? humans(channel) : null;
    if (targets === null) return replyError(i, 'Pick a member or a channel.');
    if (!targets.length) return replyError(i, 'Nobody to disconnect.');

    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const done = await moveAll(targets, null);
    const by = i.user.username;
    const where = channel ? ` from ${channel}` : '';
    logTo(i.guild, `🔌 **${by}** disconnected ${done} member(s)${where}`);
    return i.editReply({ embeds: [ok(`${done} member(s) disconnected.`)] });
  },
};

// ---------- /shake ----------

const shakeRuns = new Map<string, { cancelled: boolean; by: string }>();

const shake: Command = {
  data: new SlashCommandBuilder()
    .setName('shake')
    .setDescription('Bounce a member through random channels to wake them up')
    .setDefaultMemberPermissions(MOD)
    .addUserOption((o) => o.setName('member').setDescription('Member to wake up').setRequired(true))
    .addIntegerOption((o) => o.setName('times').setDescription('Number of moves (default 10)').setMinValue(1).setMaxValue(30))
    .addChannelOption((o) =>
      o
        .setName('to')
        .setDescription('Where to drop them at the end (default: where they were)')
        .addChannelTypes(...VOICE_TYPES)
    ),
  async run(i) {
    if (!(await requireVoiceMod(i))) return;
    const target = i.options.getMember('member');
    if (!target?.voice.channel) return replyError(i, 'This member is not in voice.');
    const hits = i.options.getInteger('times') ?? 10;
    const origin = target.voice.channel;
    const finalChannel = i.options.getChannel('to', false, [...VOICE_TYPES]) ?? origin;
    const channels = movableChannels(i.guild);
    if (channels.length < 2) return replyError(i, 'Not enough voice channels I can use.');

    const run = { cancelled: false, by: i.user.id };
    shakeRuns.set(i.id, run);
    const stopRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`shake:stop:${i.id}`).setLabel('Stop').setEmoji('✋').setStyle(ButtonStyle.Danger)
    );
    const title = `🫨 Waking up ${target.displayName}`;
    const progress = (n: number) => embed(COLOR.warn, `Shake ${n}/${hits}…`, title);
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

    const doneTitle = run.cancelled ? '✋ Stopped' : error ? '⚠️ Interrupted' : '✅ Done';
    const text = `${target} was shaken ${moved} time(s), then dropped in ${finalChannel}.` + (error ? `\n${error}` : '');
    const by = i.user.username;
    const who = target.user.username;
    logTo(i.guild, `🫨 **${by}** shook **${who}** (${moved} times)`);
    return i.editReply({ embeds: [embed(error ? COLOR.warn : COLOR.success, text, doneTitle)], components: [] });
  },
};

export const shakeStop: ComponentHandler = async (i, [action, runId]) => {
  const run = shakeRuns.get(runId);
  if (action !== 'stop' || !run) return i.deferUpdate();
  if (run.by !== i.user.id && !canModerateVoice(i.member)) {
    return replyError(i, 'Only staff can stop this.');
  }
  run.cancelled = true;
  return i.deferUpdate();
};

export const voiceCommands = [move, gather, split, disconnect, shake];
