import {
  PermissionFlagsBits,
  type GuildMember,
  type MessageComponentInteraction,
  type RepliableInteraction,
} from 'discord.js';
import { env } from '../env.js';
import { getConfig } from './config.js';
import { replyError } from './ui.js';

type CachedReplyable = RepliableInteraction<'cached'> | MessageComponentInteraction<'cached'>;

/** Propriétaire du serveur, ou OWNER_ID : passe partout, même sans rôle. */
export function isOwner(member: GuildMember) {
  return member.id === member.guild.ownerId || (env.ownerId !== null && member.id === env.ownerId);
}

/** Propriétaire, Administrateur, ou un rôle de l'étage Staff. */
export function isPrivileged(member: GuildMember) {
  if (isOwner(member)) return true;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  return getConfig(member.guild.id).staffRoles.some((id) => member.roles.cache.has(id));
}

export function canModerateVoice(member: GuildMember) {
  return isPrivileged(member) || member.permissions.has(PermissionFlagsBits.MoveMembers);
}

export async function requireVoiceMod(i: CachedReplyable) {
  if (canModerateVoice(i.member)) return true;
  await replyError(i, 'Il te faut la permission **Déplacer des membres**.');
  return false;
}

export async function requirePrivileged(i: CachedReplyable) {
  if (isPrivileged(i.member)) return true;
  await replyError(i, 'Commande réservée au staff.');
  return false;
}
