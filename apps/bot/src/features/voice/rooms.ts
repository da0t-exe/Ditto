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
import { loc, tr, userLang } from '../../core/i18n.js';
import { log } from '../../core/log.js';
import { logTo } from '../../core/logs.js';
import { canModerateVoice } from '../../core/perms.js';
import type { Command } from '../../core/types.js';
import { ok, replyError } from '../../core/ui.js';
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
const selectRoom = db.prepare<[string], { defaults: string; owner_id: string | null }>(
  'SELECT defaults, owner_id FROM rooms WHERE channel_id = ?'
);
const setOwner = db.prepare('UPDATE rooms SET owner_id = ? WHERE channel_id = ?');

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
  logTo(channel.guild, `♻️ ${channel} is back to normal`, `♻️ ${channel} est revenue à la normale`);
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

/** Records each room's original state (once) and resets rooms left empty. */
export async function prepareRooms(guild: Guild) {
  for (const id of getConfig(guild.id).rooms) {
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
  data: loc(new SlashCommandBuilder(), 'room', ['Customise the room you are in (if you own it)', 'Personnaliser la salle où tu es (si tu en es propriétaire)'])
    .addSubcommand((s) =>
      loc(s, ['name', 'nom'], ['Rename the room', 'Renommer la salle']).addStringOption((o) =>
        loc(o, ['text', 'texte'], ['New name', 'Nouveau nom']).setMaxLength(50).setRequired(true)
      )
    )
    .addSubcommand((s) =>
      loc(s, ['limit', 'limite'], ['Number of slots (0 = no limit)', 'Nombre de places (0 = illimité)']).addIntegerOption((o) =>
        loc(o, ['slots', 'places'], ['Slots', 'Places']).setMinValue(0).setMaxValue(99).setRequired(true)
      )
    )
    .addSubcommand((s) => loc(s, ['lock', 'verrouiller'], ['Nobody else can join, except guests', 'Plus personne ne peut entrer, sauf les invités']))
    .addSubcommand((s) => loc(s, ['unlock', 'deverrouiller'], ['Open the room again', 'Rouvrir la salle']))
    .addSubcommand((s) =>
      loc(s, ['invite', 'inviter'], ['Let a member in', 'Autoriser un membre à entrer']).addUserOption((o) =>
        loc(o, ['member', 'membre'], ['Member', 'Membre']).setRequired(true)
      )
    )
    .addSubcommand((s) =>
      loc(s, ['transfer', 'transferer'], ['Give the room to someone else', 'Donner la salle à quelqu’un d’autre']).addUserOption((o) =>
        loc(o, ['member', 'membre'], ['New owner', 'Nouveau propriétaire']).setRequired(true)
      )
    ),
  async run(i) {
    const lang = userLang(i);
    const channel = i.member.voice.channel;
    const room = roomOf(i.guildId, channel?.id ?? null);
    if (!channel || !room) return replyError(i, tr(lang, 'Join one of the rooms first.', 'Rejoins une des salles vocales d’abord.'));
    if (room.ownerId !== i.user.id && !canModerateVoice(i.member)) {
      return replyError(
        i,
        tr(lang, `Only the room’s owner (<@${room.ownerId}>) can change it.`, `Seul le propriétaire de la salle (<@${room.ownerId}>) peut la modifier.`)
      );
    }
    const cfg = getConfig(i.guildId);
    const sub = i.options.getSubcommand();
    const reply = (en: string, fr: string) => i.reply({ embeds: [ok(tr(lang, en, fr))], flags: MessageFlags.Ephemeral });

    if (sub === 'name') {
      await channel.setName(i.options.getString('text', true));
      return reply(
        'Room renamed. (Discord allows 2 renames every 10 minutes.)',
        'Salle renommée. (Discord limite les renommages à 2 toutes les 10 minutes.)'
      );
    }
    if (sub === 'limit') {
      const slots = i.options.getInteger('slots', true);
      if (!('setUserLimit' in channel)) return replyError(i, tr(lang, 'This channel has no user limit.', 'Pas de limite possible ici.'));
      await channel.setUserLimit(slots);
      return slots ? reply(`Limit set to ${slots}.`, `Limite fixée à ${slots}.`) : reply('Limit removed.', 'Limite retirée.');
    }
    if (sub === 'lock') {
      await channel.permissionOverwrites.edit(i.guild.roles.everyone, { Connect: false });
      if (cfg.memberRole) await channel.permissionOverwrites.edit(cfg.memberRole, { Connect: false });
      for (const m of channel.members.values()) await channel.permissionOverwrites.edit(m, { Connect: true });
      return reply('Room locked. Use `/room invite` to let someone in.', 'Salle verrouillée. Utilise `/room inviter` pour laisser entrer quelqu’un.');
    }
    if (sub === 'unlock') {
      await channel.permissionOverwrites.set(toOverwrites(room.defaults));
      return reply('Room open again.', 'Salle rouverte.');
    }
    const target = i.options.getMember('member');
    if (!target) return replyError(i, tr(lang, 'Member not found.', 'Membre introuvable.'));
    if (sub === 'invite') {
      await channel.permissionOverwrites.edit(target, { Connect: true, ViewChannel: true });
      return reply(`${target} can join.`, `${target} peut entrer.`);
    }
    // transfer
    if (!channel.members.has(target.id)) return replyError(i, tr(lang, `${target} must be in the room.`, `${target} doit être dans la salle.`));
    setOwner.run(target.id, channel.id);
    return reply(`${target} now owns the room.`, `${target} est maintenant propriétaire de la salle.`);
  },
};

export function initRooms(client: Client) {
  client.on(Events.VoiceStateUpdate, (o, n) => {
    onVoice(o, n).catch((err) => log.warn('rooms', err.message));
  });
}
