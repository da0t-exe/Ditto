import {
  ActionRowBuilder,
  Events,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  type Client,
  type Guild,
  type GuildMember,
  type VoiceState,
} from 'discord.js';
import { db } from '../../core/db.js';
import { log } from '../../core/log.js';
import { logTo } from '../../core/logs.js';
import { canModerateVoice, requireVoiceMod } from '../../core/perms.js';
import type { Command, ComponentHandler } from '../../core/types.js';
import { COLOR, embed, ok, parseDuration, replyError } from '../../core/ui.js';
import { humans, VOICE_TYPES, wasMovedByCommand } from './util.js';

/**
 * Lock: members in the channel (and anyone who joins it) are tracked. If they
 * leave for another channel, or come back to voice somewhere else, they are
 * pulled back. Staff are never tracked, and the AFK channel is always allowed.
 */
interface Lock {
  guildId: string;
  channelId: string;
  members: Set<string>;
  expiresAt: number | null;
  createdBy: string;
}

const locks = new Map<string, Lock>();

const upsert = db.prepare(
  `INSERT INTO voice_locks (channel_id, guild_id, members, expires_at, created_by) VALUES (?, ?, ?, ?, ?)
   ON CONFLICT(channel_id) DO UPDATE SET members = excluded.members, expires_at = excluded.expires_at`
);
const del = db.prepare('DELETE FROM voice_locks WHERE channel_id = ?');
const all = db.prepare<[], { channel_id: string; guild_id: string; members: string; expires_at: number | null; created_by: string }>(
  'SELECT * FROM voice_locks'
);

function save(lock: Lock) {
  upsert.run(lock.channelId, lock.guildId, JSON.stringify([...lock.members]), lock.expiresAt, lock.createdBy);
}

function unlock(channelId: string) {
  locks.delete(channelId);
  del.run(channelId);
}

const guildLocks = (guildId: string) => [...locks.values()].filter((l) => l.guildId === guildId);

/** For the dashboard. */
export const listLocks = (guildId: string) =>
  guildLocks(guildId).map((l) => ({ channelId: l.channelId, members: l.members.size, expiresAt: l.expiresAt, createdBy: l.createdBy }));

export function removeLock(guild: Guild, channelId: string, by: string) {
  if (!locks.has(channelId) || locks.get(channelId)!.guildId !== guild.id) return false;
  unlock(channelId);
  logTo(guild, `🔓 **${by}** unlocked <#${channelId}>`);
  return true;
}

async function pullBack(member: GuildMember, channelId: string) {
  const channel = member.guild.channels.cache.get(channelId);
  if (!channel?.isVoiceBased()) return;
  try {
    await member.voice.setChannel(channel);
    const name = member.user.username;
    logTo(member.guild, `🔒 **${name}** pulled back into ${channel}`);
  } catch (err) {
    log.warn('lock', `${member.user.tag} -> ${channel.name}: ${(err as Error).message}`);
  }
}

async function onVoice(oldState: VoiceState, newState: VoiceState) {
  const member = newState.member;
  if (!member || member.user.bot) return;
  const guildId = newState.guild.id;
  if (!guildLocks(guildId).length) return;

  // Moved on purpose by staff: stop tracking them.
  if (wasMovedByCommand(member.id)) {
    for (const l of guildLocks(guildId)) if (l.members.delete(member.id)) save(l);
    return;
  }
  if (canModerateVoice(member)) return;

  const joined = newState.channelId ? locks.get(newState.channelId) : undefined;
  if (joined && !joined.members.has(member.id)) {
    joined.members.add(member.id);
    save(joined);
  }

  if (!newState.channelId || newState.channelId === newState.guild.afkChannelId) return;

  const left = oldState.channelId ? locks.get(oldState.channelId) : undefined;
  if (left && newState.channelId !== left.channelId) return pullBack(member, left.channelId);

  const home = guildLocks(guildId).find((l) => l.members.has(member.id));
  if (home && newState.channelId !== home.channelId) return pullBack(member, home.channelId);
}

function sweepExpired(client: Client) {
  const now = Date.now();
  for (const l of [...locks.values()]) {
    if (l.expiresAt === null || l.expiresAt > now) continue;
    unlock(l.channelId);
    const guild = client.guilds.cache.get(l.guildId);
    if (guild) logTo(guild, `🔓 Lock on <#${l.channelId}> expired`);
  }
}

// ---------- Commands ----------

const lockCmd: Command = {
  data: new SlashCommandBuilder()
    .setName('lock')
    .setDescription('Lock a channel: members who leave are pulled back')
    .setDefaultMemberPermissions(PermissionFlagsBits.MoveMembers)
    .addChannelOption((o) =>
      o
        .setName('channel')
        .setDescription('Channel to lock')
        .addChannelTypes(...VOICE_TYPES)
        .setRequired(true)
    )
    .addStringOption((o) => o.setName('duration').setDescription('e.g. 30m, 2h, 1h30 (no limit by default)')),
  async run(i) {
    if (!(await requireVoiceMod(i))) return;
    const channel = i.options.getChannel('channel', true, [...VOICE_TYPES]);
    const raw = i.options.getString('duration');
    const duration = raw ? parseDuration(raw) : null;
    if (raw && duration === null) {
      return replyError(i, 'Invalid duration. Examples: `30m`, `2h`, `1h30`.');
    }

    const lock: Lock = {
      guildId: i.guildId,
      channelId: channel.id,
      members: new Set(
        humans(channel)
          .filter((m) => !canModerateVoice(m))
          .map((m) => m.id)
      ),
      expiresAt: duration ? Date.now() + duration : null,
      createdBy: i.user.id,
    };
    locks.set(channel.id, lock);
    save(lock);

    const at = lock.expiresAt ? `<t:${Math.floor(lock.expiresAt / 1000)}:t>` : '';
    const by = i.user.username;
    logTo(i.guild, `🔒 **${by}** locked ${channel}${at ? ` until ${at}` : ''}`);
    return i.reply({
      embeds: [ok(`${channel} is locked${at ? ` until ${at}` : ''}. ${lock.members.size} member(s) tracked; anyone who joins will be tracked too.`)],
    });
  },
};

const unlockCmd: Command = {
  data: new SlashCommandBuilder()
    .setName('unlock')
    .setDescription('Unlock a channel')
    .setDefaultMemberPermissions(PermissionFlagsBits.MoveMembers)
    .addChannelOption((o) =>
      o
        .setName('channel')
        .setDescription('Channel to unlock')
        .addChannelTypes(...VOICE_TYPES)
        .setRequired(true)
    ),
  async run(i) {
    if (!(await requireVoiceMod(i))) return;
    const channel = i.options.getChannel('channel', true, [...VOICE_TYPES]);
    if (!locks.has(channel.id)) return replyError(i, `${channel} is not locked.`);
    unlock(channel.id);
    const by = i.user.username;
    logTo(i.guild, `🔓 **${by}** unlocked ${channel}`);
    return i.reply({ embeds: [ok(`${channel} is unlocked.`)] });
  },
};

function locksView(guild: Guild) {
  const list = guildLocks(guild.id);
  const title = '🔒 Locks';
  if (!list.length) return { embeds: [embed(COLOR.neutral, 'No locked channel.', title)], components: [] };
  const lines = list.map((l) => {
    const until = l.expiresAt ? `until <t:${Math.floor(l.expiresAt / 1000)}:t>` : 'no limit';
    return `<#${l.channelId}> — ${l.members.size} tracked, ${until}, by <@${l.createdBy}>`;
  });
  const menu = new StringSelectMenuBuilder()
    .setCustomId('lock:unlock')
    .setPlaceholder('Unlock…')
    .addOptions(list.slice(0, 25).map((l) => ({ label: guild.channels.cache.get(l.channelId)?.name ?? l.channelId, value: l.channelId })));
  return {
    embeds: [embed(COLOR.primary, lines.join('\n'), title)],
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
  };
}

const locksCmd: Command = {
  data: new SlashCommandBuilder()
    .setName('locks')
    .setDescription('List locked channels')
    .setDefaultMemberPermissions(PermissionFlagsBits.MoveMembers),
  async run(i) {
    if (!(await requireVoiceMod(i))) return;
    return i.reply({ ...locksView(i.guild), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  },
};

export const lockComponent: ComponentHandler = async (i, [action]) => {
  if (action !== 'unlock' || !i.isStringSelectMenu() || !(await requireVoiceMod(i))) return;
  const by = i.user.username;
  for (const id of i.values) {
    if (!locks.has(id)) continue;
    unlock(id);
    logTo(i.guild, `🔓 **${by}** unlocked <#${id}>`);
  }
  return i.update(locksView(i.guild));
};

export const lockCommands = [lockCmd, unlockCmd, locksCmd];

export function initLocks(client: Client) {
  for (const row of all.all()) {
    locks.set(row.channel_id, {
      guildId: row.guild_id,
      channelId: row.channel_id,
      members: new Set(JSON.parse(row.members) as string[]),
      expiresAt: row.expires_at,
      createdBy: row.created_by,
    });
  }
  client.on(Events.VoiceStateUpdate, (o, n) => {
    onVoice(o, n).catch((err) => log.warn('lock', err.message));
  });
  setInterval(() => sweepExpired(client), 30_000).unref();
}
