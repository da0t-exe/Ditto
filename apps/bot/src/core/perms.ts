import { PermissionFlagsBits, type GuildMember, type MessageComponentInteraction, type RepliableInteraction } from 'discord.js';
import { env } from '../env.js';
import { getConfig } from './config.js';
import { replyError } from './ui.js';

type CachedReplyable = RepliableInteraction<'cached'> | MessageComponentInteraction<'cached'>;

/** The server owner, or OWNER_ID: passes every check, with or without roles. */
export function isOwner(member: GuildMember) {
  return member.id === member.guild.ownerId || (env.ownerId !== null && member.id === env.ownerId);
}

/** Owner, Administrator, or one of the staff roles picked in /setup. */
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
  await replyError(i, 'You need the **Move Members** permission, or a staff role.');
  return false;
}

export async function requirePrivileged(i: CachedReplyable) {
  if (isPrivileged(i.member)) return true;
  await replyError(i, 'Staff only.');
  return false;
}
