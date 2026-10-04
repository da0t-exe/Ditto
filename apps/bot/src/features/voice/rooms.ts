import {
  Events,
  MessageFlags,
  OverwriteType,
  SlashCommandBuilder,
  type Client,
  type Guild,
  type VoiceBasedChannel,
  type VoiceState,
} from 'discord.js';
import { getConfig } from '../../core/config.js';
import { db } from '../../core/db.js';
import { log } from '../../core/log.js';
import { logTo } from '../../core/logs.js';
import { canModerateVoice } from '../../core/perms.js';
import type { Command } from '../../core/types.js';
import { ok, replyError } from '../../core/ui.js';
import { runsOn } from '../../env.js';
import { humans } from './util.js';

/**
 * Rooms picked in /setup: the first person in an empty room owns it and can
 * customise it with /room. When everyone has left, the room goes back to its
 * original name, user limit and permissions.
 */
interface Defaults {
  name: string;
  userLimit: number;
  overwrites: { id: string; type: OverwriteType; allow: string; deny: string }[];
}

const insertRoom = db.prepare('INSERT OR IGNORE INTO rooms (channel_id, guild_id, defaults, owner_id) VALUES (?, ?, ?, NULL)');
const selectRoom = db.prepare<[string], { defaults: string; owner_id: string | null }>('SELECT defaults, owner_id FROM rooms WHERE channel_id = ?');
const setOwner = db.prepare('UPDATE rooms SET owner_id = ? WHERE channel_id = ?');
const roomsOf = db.prepare<[string], { channel_id: string }>('SELECT channel_id FROM rooms WHERE guild_id = ?');
const deleteRoom = db.prepare('DELETE FROM rooms WHERE channel_id = ?');

function snapshot(channel: VoiceBasedChannel): Defaults {
  return {
    name: channel.name,
    userLimit: 'userLimit' in channel ? channel.userLimit : 0,
    overwrites: channel.permissionOverwrites.cache.map((o) => ({
      id: o.id,
      type: o.type,
      allow: o.allow.bitfield.toString(),
      deny: o.deny.bitfield.toString(),
    })),
  };
}

/** A room only counts while it is still picked in /setup. */
function roomOf(guildId: string, channelId: string | null) {
  if (!channelId || !getConfig(guildId).rooms.includes(channelId)) return null;
  const row = selectRoom.get(channelId);
  return row ? { defaults: JSON.parse(row.defaults) as Defaults, ownerId: row.owner_id } : null;
}

const toOverwrites = (d: Defaults) => d.overwrites.map((o) => ({ id: o.id, type: o.type, allow: BigInt(o.allow), deny: BigInt(o.deny) }));

async function reset(channel: VoiceBasedChannel, d: Defaults) {
  const current = snapshot(channel);
  const byId = (a: Defaults['overwrites']) => JSON.stringify([...a].sort((x, y) => x.id.localeCompare(y.id)));
  if (current.name === d.name && current.userLimit === d.userLimit && byId(current.overwrites) === byId(d.overwrites)) return;
  await channel.edit({
    name: d.name,
    userLimit: d.userLimit,
    permissionOverwrites: toOverwrites(d),
    reason: 'Room empty: back to normal',
  });
  logTo(channel.guild, `♻️ ${channel} is back to normal`);
}

async function onVoice(oldState: VoiceState, newState: VoiceState) {
  if (oldState.channelId === newState.channelId) return;
  const member = newState.member;
  if (!member || member.user.bot) return;
  const guildId = newState.guild.id;

  const left = roomOf(guildId, oldState.channelId);
  if (left && oldState.channel) {
    const remaining = humans(oldState.channel);
    if (!remaining.length) {
      setOwner.run(null, oldState.channel.id);
      await reset(oldState.channel, left.defaults);
    } else if (left.ownerId === member.id) {
      setOwner.run(remaining[0].id, oldState.channel.id);
    }
  }

  const joined = roomOf(guildId, newState.channelId);
  if (joined && newState.channel) {
    const ownerHere = joined.ownerId && newState.channel.members.has(joined.ownerId);
    if (!ownerHere) setOwner.run(member.id, newState.channel.id);
  }
}

/**
 * Records each room's original state and resets rooms left empty. A room taken out of
 * /setup is forgotten, so picking it again records its state as it is then.
 */
export async function prepareRooms(guild: Guild) {
  const picked = getConfig(guild.id).rooms;
  for (const { channel_id } of roomsOf.all(guild.id)) if (!picked.includes(channel_id)) deleteRoom.run(channel_id);
  for (const id of picked) {
    const channel = guild.channels.cache.get(id);
    if (!channel?.isVoiceBased()) continue;
    insertRoom.run(channel.id, guild.id, JSON.stringify(snapshot(channel)));
    const room = roomOf(guild.id, channel.id)!;
    if (!humans(channel).length) {
      setOwner.run(null, channel.id);
      await reset(channel, room.defaults).catch((err) => log.warn('rooms', err.message));
    } else if (!room.ownerId || !channel.members.has(room.ownerId)) {
      setOwner.run(humans(channel)[0].id, channel.id);
    }
  }
}

export const roomCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('room')
    .setDescription('Customise the room you are in (if you own it)')
    .addSubcommand((s) =>
      s
        .setName('name')
        .setDescription('Rename the room')
        .addStringOption((o) => o.setName('text').setDescription('New name').setMaxLength(50).setRequired(true))
    )
    .addSubcommand((s) =>
      s
        .setName('limit')
        .setDescription('Number of slots (0 = no limit)')
        .addIntegerOption((o) => o.setName('slots').setDescription('Slots').setMinValue(0).setMaxValue(99).setRequired(true))
    )
    .addSubcommand((s) => s.setName('lock').setDescription('Nobody else can join, except guests'))
    .addSubcommand((s) => s.setName('unlock').setDescription('Open the room again'))
    .addSubcommand((s) =>
      s
        .setName('invite')
        .setDescription('Let a member in')
        .addUserOption((o) => o.setName('member').setDescription('Member').setRequired(true))
    )
    .addSubcommand((s) =>
      s
        .setName('transfer')
        .setDescription('Give the room to someone else')
        .addUserOption((o) => o.setName('member').setDescription('New owner').setRequired(true))
    ),
  async run(i) {
    const channel = i.member.voice.channel;
    const room = roomOf(i.guildId, channel?.id ?? null);
    if (!channel || !room) return replyError(i, 'Join one of the rooms first.');
    if (room.ownerId !== i.user.id && !canModerateVoice(i.member)) {
      return replyError(i, room.ownerId ? `Only the room’s owner (<@${room.ownerId}>) can change it.` : 'Only the room’s owner can change it.');
    }
    const cfg = getConfig(i.guildId);
    const sub = i.options.getSubcommand();
    // Changing a channel can take longer than Discord waits for an answer (several
    // permission edits, or a rename held back by Discord's own limit).
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const reply = (message: string) => i.editReply({ embeds: [ok(message)] });

    try {
      if (sub === 'name') {
        await channel.setName(i.options.getString('text', true));
        return await reply('Room renamed. (Discord allows 2 renames every 10 minutes.)');
      }
      if (sub === 'limit') {
        const slots = i.options.getInteger('slots', true);
        if (!('setUserLimit' in channel)) return await replyError(i, 'This channel has no user limit.');
        await channel.setUserLimit(slots);
        return await (slots ? reply(`Limit set to ${slots}.`) : reply('Limit removed.'));
      }
      if (sub === 'lock') {
        await channel.permissionOverwrites.edit(i.guild.roles.everyone, { Connect: false });
        if (cfg.memberRole && i.guild.roles.cache.has(cfg.memberRole)) await channel.permissionOverwrites.edit(cfg.memberRole, { Connect: false });
        for (const m of channel.members.values()) await channel.permissionOverwrites.edit(m, { Connect: true });
        return await reply('Room locked. Use `/room invite` to let someone in.');
      }
      if (sub === 'unlock') {
        await channel.permissionOverwrites.set(toOverwrites(room.defaults));
        return await reply('Room open again.');
      }
      const target = i.options.getMember('member');
      if (!target) return await replyError(i, 'Member not found.');
      if (sub === 'invite') {
        await channel.permissionOverwrites.edit(target, { Connect: true, ViewChannel: true });
        return await reply(`${target} can join.`);
      }
      // transfer
      if (!channel.members.has(target.id)) return await replyError(i, `${target} must be in the room.`);
      setOwner.run(target.id, channel.id);
      return await reply(`${target} now owns the room.`);
    } catch (err) {
      // 50013 Missing Permissions, 50001 Missing Access: say what to fix rather than « something went wrong ».
      const code = (err as { code?: number }).code;
      if (code !== 50013 && code !== 50001) throw err;
      return replyError(i, `I cannot change ${channel}: give me **Manage Channels** and **Manage Permissions** on it.`);
    }
  },
};

export function initRooms(client: Client) {
  client.on(Events.VoiceStateUpdate, (o, n) => {
    if (runsOn(n.guild.id)) onVoice(o, n).catch((err) => log.warn('rooms', err.message));
  });
}
