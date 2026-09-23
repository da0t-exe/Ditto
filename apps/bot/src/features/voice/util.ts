import { ChannelType, PermissionFlagsBits, type Guild, type GuildMember, type VoiceBasedChannel } from 'discord.js';

/**
 * Déplacements faits par une commande de modération : le verrou (/lock) les laisse passer
 * et arrête de suivre le membre, sinon il le ramènerait aussitôt.
 */
const commandMoves = new Map<string, number>();

export function wasMovedByCommand(memberId: string) {
  const until = commandMoves.get(memberId);
  if (until === undefined) return false;
  if (until < Date.now()) {
    commandMoves.delete(memberId);
    return false;
  }
  return true;
}

export async function moveByCommand(member: GuildMember, channel: VoiceBasedChannel | null) {
  commandMoves.set(member.id, Date.now() + 8000);
  await member.voice.setChannel(channel);
}

/** Salons vocaux où le bot peut déplacer des gens (hors AFK). */
export function movableChannels(guild: Guild): VoiceBasedChannel[] {
  const me = guild.members.me;
  return [
    ...guild.channels.cache
      .filter(
        (c): c is VoiceBasedChannel =>
          (c.type === ChannelType.GuildVoice || c.type === ChannelType.GuildStageVoice) &&
          c.id !== guild.afkChannelId &&
          !!me &&
          !!c.permissionsFor(me)?.has([PermissionFlagsBits.Connect, PermissionFlagsBits.MoveMembers])
      )
      .values(),
  ];
}

export const humans = (channel: VoiceBasedChannel) => [...channel.members.values()].filter((m) => !m.user.bot);

export function shuffle<T>(items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export const VOICE_TYPES = [ChannelType.GuildVoice, ChannelType.GuildStageVoice] as const;
