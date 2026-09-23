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
import { humans } from './util.js';

/**
 * Salles A/B/C/D : la première personne qui entre dans une salle vide en devient
 * propriétaire et peut la personnaliser avec /room. Quand tout le monde est parti,
 * la salle reprend son nom, sa limite et ses permissions d'origine.
 */
interface Defaults {
  name: string;
  userLimit: number;
  overwrites: { id: string; type: OverwriteType; allow: string; deny: string }[];
}

const insertRoom = db.prepare(
  'INSERT OR IGNORE INTO rooms (channel_id, guild_id, defaults, owner_id) VALUES (?, ?, ?, NULL)'
);
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

function roomOf(channelId: string | null) {
  if (!channelId) return null;
  const row = selectRoom.get(channelId);
  return row ? { defaults: JSON.parse(row.defaults) as Defaults, ownerId: row.owner_id } : null;
}

async function reset(channel: VoiceBasedChannel, d: Defaults) {
  const current = snapshot(channel);
  const sameOverwrites =
    JSON.stringify([...current.overwrites].sort((a, b) => a.id.localeCompare(b.id))) ===
    JSON.stringify([...d.overwrites].sort((a, b) => a.id.localeCompare(b.id)));
  if (current.name === d.name && current.userLimit === d.userLimit && sameOverwrites) return;
  await channel.edit({
    name: d.name,
    userLimit: d.userLimit,
    permissionOverwrites: d.overwrites.map((o) => ({ id: o.id, type: o.type, allow: BigInt(o.allow), deny: BigInt(o.deny) })),
    reason: 'Salle vide : retour à la normale',
  });
  logTo(channel.guild, `♻️ ${channel} est revenue à la normale`);
}

async function onVoice(oldState: VoiceState, newState: VoiceState) {
  if (oldState.channelId === newState.channelId) return;
  const member = newState.member;
  if (!member || member.user.bot) return;

  const left = roomOf(oldState.channelId);
  if (left && oldState.channel) {
    const remaining = humans(oldState.channel);
    if (!remaining.length) {
      setOwner.run(null, oldState.channel.id);
      await reset(oldState.channel, left.defaults);
    } else if (left.ownerId === member.id) {
      setOwner.run(remaining[0].id, oldState.channel.id);
    }
  }

  const joined = roomOf(newState.channelId);
  if (joined && newState.channel) {
    const ownerHere = joined.ownerId && newState.channel.members.has(joined.ownerId);
    if (!ownerHere) setOwner.run(member.id, newState.channel.id);
  }
}

/** Enregistre l'état d'origine des salles (une seule fois) et remet à zéro celles restées vides. */
export async function prepareRooms(guild: Guild) {
  for (const id of getConfig(guild.id).rooms) {
    const channel = guild.channels.cache.get(id);
    if (!channel?.isVoiceBased()) continue;
    insertRoom.run(channel.id, guild.id, JSON.stringify(snapshot(channel)));
    const room = roomOf(channel.id)!;
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
    .setDescription('Personnaliser la salle où tu es (si tu en es propriétaire)')
    .addSubcommand((s) =>
      s.setName('nom').setDescription('Renommer la salle').addStringOption((o) =>
        o.setName('texte').setDescription('Nouveau nom').setMaxLength(50).setRequired(true)
      )
    )
    .addSubcommand((s) =>
      s.setName('limite').setDescription('Nombre de places (0 = illimité)').addIntegerOption((o) =>
        o.setName('places').setDescription('Places').setMinValue(0).setMaxValue(99).setRequired(true)
      )
    )
    .addSubcommand((s) => s.setName('verrouiller').setDescription('Plus personne ne peut entrer, sauf les invités'))
    .addSubcommand((s) => s.setName('deverrouiller').setDescription('Rouvrir la salle'))
    .addSubcommand((s) =>
      s.setName('inviter').setDescription('Autoriser un membre à entrer').addUserOption((o) =>
        o.setName('membre').setDescription('Membre').setRequired(true)
      )
    )
    .addSubcommand((s) =>
      s.setName('transferer').setDescription('Donner la salle à quelqu’un d’autre').addUserOption((o) =>
        o.setName('membre').setDescription('Nouveau propriétaire').setRequired(true)
      )
    ),
  async run(i) {
    const channel = i.member.voice.channel;
    const room = roomOf(channel?.id ?? null);
    if (!channel || !room) return replyError(i, 'Rejoins une des salles vocales d’abord.');
    if (room.ownerId !== i.user.id && !canModerateVoice(i.member)) {
      return replyError(i, `Seul le propriétaire de la salle (<@${room.ownerId}>) peut la modifier.`);
    }
    const cfg = getConfig(i.guildId);
    const sub = i.options.getSubcommand();
    const reply = (text: string) => i.reply({ embeds: [ok(text)], flags: MessageFlags.Ephemeral });

    if (sub === 'nom') {
      await channel.setName(i.options.getString('texte', true));
      return reply('Salle renommée. (Discord limite les renommages à 2 toutes les 10 minutes.)');
    }
    if (sub === 'limite') {
      const places = i.options.getInteger('places', true);
      if (!('setUserLimit' in channel)) return replyError(i, 'Pas de limite possible ici.');
      await channel.setUserLimit(places);
      return reply(places ? `Limite fixée à ${places}.` : 'Limite retirée.');
    }
    if (sub === 'verrouiller') {
      await channel.permissionOverwrites.edit(i.guild.roles.everyone, { Connect: false });
      if (cfg.membersRole) await channel.permissionOverwrites.edit(cfg.membersRole, { Connect: false });
      for (const m of channel.members.values()) await channel.permissionOverwrites.edit(m, { Connect: true });
      return reply('Salle verrouillée. Utilise `/room inviter` pour laisser entrer quelqu’un.');
    }
    if (sub === 'deverrouiller') {
      await channel.permissionOverwrites.set(
        room.defaults.overwrites.map((o) => ({ id: o.id, type: o.type, allow: BigInt(o.allow), deny: BigInt(o.deny) }))
      );
      return reply('Salle rouverte.');
    }
    const target = i.options.getMember('membre');
    if (!target) return replyError(i, 'Membre introuvable.');
    if (sub === 'inviter') {
      await channel.permissionOverwrites.edit(target, { Connect: true, ViewChannel: true });
      return reply(`${target} peut entrer.`);
    }
    // transferer
    if (!channel.members.has(target.id)) return replyError(i, `${target} doit être dans la salle.`);
    setOwner.run(target.id, channel.id);
    return reply(`${target} est maintenant propriétaire de la salle.`);
  },
};

export function initRooms(client: Client) {
  client.on(Events.VoiceStateUpdate, (o, n) => {
    onVoice(o, n).catch((err) => log.warn('rooms', err.message));
  });
}
