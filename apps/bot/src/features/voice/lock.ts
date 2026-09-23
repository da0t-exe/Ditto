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
import { loc, tr, userLang, type Lang } from '../../core/i18n.js';
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

async function pullBack(member: GuildMember, channelId: string) {
  const channel = member.guild.channels.cache.get(channelId);
  if (!channel?.isVoiceBased()) return;
  try {
    await member.voice.setChannel(channel);
    const name = member.user.username;
    logTo(member.guild, `🔒 **${name}** pulled back into ${channel}`, `🔒 **${name}** ramené dans ${channel}`);
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
    if (guild) logTo(guild, `🔓 Lock on <#${l.channelId}> expired`, `🔓 Verrou de <#${l.channelId}> expiré`);
  }
}

// ---------- Commands ----------

const lockCmd: Command = {
  data: loc(new SlashCommandBuilder(), 'lock', ['Lock a channel: members who leave are pulled back', 'Verrouiller un salon : ceux qui partent sont ramenés'])
    .setDefaultMemberPermissions(PermissionFlagsBits.MoveMembers)
    .addChannelOption((o) =>
      loc(o, ['channel', 'salon'], ['Channel to lock', 'Salon à verrouiller']).addChannelTypes(...VOICE_TYPES).setRequired(true)
    )
    .addStringOption((o) => loc(o, ['duration', 'duree'], ['e.g. 30m, 2h, 1h30 (no limit by default)', 'Ex. 30m, 2h, 1h30 (sans limite par défaut)'])),
  async run(i) {
    if (!(await requireVoiceMod(i))) return;
    const lang = userLang(i);
    const channel = i.options.getChannel('channel', true, [...VOICE_TYPES]);
    const raw = i.options.getString('duration');
    const duration = raw ? parseDuration(raw) : null;
    if (raw && duration === null) {
      return replyError(i, tr(lang, 'Invalid duration. Examples: `30m`, `2h`, `1h30`.', 'Durée invalide. Exemples : `30m`, `2h`, `1h30`.'));
    }

    const lock: Lock = {
      guildId: i.guildId,
      channelId: channel.id,
      members: new Set(humans(channel).filter((m) => !canModerateVoice(m)).map((m) => m.id)),
      expiresAt: duration ? Date.now() + duration : null,
      createdBy: i.user.id,
    };
    locks.set(channel.id, lock);
    save(lock);

    const at = lock.expiresAt ? `<t:${Math.floor(lock.expiresAt / 1000)}:t>` : '';
    const by = i.user.username;
    logTo(
      i.guild,
      `🔒 **${by}** locked ${channel}${at ? ` until ${at}` : ''}`,
      `🔒 **${by}** a verrouillé ${channel}${at ? ` jusqu'à ${at}` : ''}`
    );
    return i.reply({
      embeds: [
        ok(
          tr(
            lang,
            `${channel} is locked${at ? ` until ${at}` : ''}. ${lock.members.size} member(s) tracked; anyone who joins will be tracked too.`,
            `${channel} est verrouillé${at ? ` jusqu'à ${at}` : ''}. ${lock.members.size} membre(s) suivi(s) ; ceux qui entrent seront suivis aussi.`
          )
        ),
      ],
    });
  },
};

const unlockCmd: Command = {
  data: loc(new SlashCommandBuilder(), 'unlock', ['Unlock a channel', 'Déverrouiller un salon'])
    .setDefaultMemberPermissions(PermissionFlagsBits.MoveMembers)
    .addChannelOption((o) =>
      loc(o, ['channel', 'salon'], ['Channel to unlock', 'Salon à déverrouiller']).addChannelTypes(...VOICE_TYPES).setRequired(true)
    ),
  async run(i) {
    if (!(await requireVoiceMod(i))) return;
    const lang = userLang(i);
    const channel = i.options.getChannel('channel', true, [...VOICE_TYPES]);
    if (!locks.has(channel.id)) return replyError(i, tr(lang, `${channel} is not locked.`, `${channel} n'est pas verrouillé.`));
    unlock(channel.id);
    const by = i.user.username;
    logTo(i.guild, `🔓 **${by}** unlocked ${channel}`, `🔓 **${by}** a déverrouillé ${channel}`);
    return i.reply({ embeds: [ok(tr(lang, `${channel} is unlocked.`, `${channel} est déverrouillé.`))] });
  },
};

function locksView(guild: Guild, lang: Lang) {
  const list = guildLocks(guild.id);
  const title = tr(lang, '🔒 Locks', '🔒 Verrous');
  if (!list.length) return { embeds: [embed(COLOR.neutral, tr(lang, 'No locked channel.', 'Aucun salon verrouillé.'), title)], components: [] };
  const lines = list.map((l) => {
    const until = l.expiresAt
      ? tr(lang, `until <t:${Math.floor(l.expiresAt / 1000)}:t>`, `jusqu'à <t:${Math.floor(l.expiresAt / 1000)}:t>`)
      : tr(lang, 'no limit', 'sans limite');
    return `<#${l.channelId}> — ${tr(lang, `${l.members.size} tracked`, `${l.members.size} suivi(s)`)}, ${until}, ${tr(lang, 'by', 'par')} <@${l.createdBy}>`;
  });
  const menu = new StringSelectMenuBuilder()
    .setCustomId('lock:unlock')
    .setPlaceholder(tr(lang, 'Unlock…', 'Déverrouiller…'))
    .addOptions(list.slice(0, 25).map((l) => ({ label: guild.channels.cache.get(l.channelId)?.name ?? l.channelId, value: l.channelId })));
  return {
    embeds: [embed(COLOR.primary, lines.join('\n'), title)],
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
  };
}

const locksCmd: Command = {
  data: loc(new SlashCommandBuilder(), 'locks', ['List locked channels', 'Voir les salons verrouillés']).setDefaultMemberPermissions(
    PermissionFlagsBits.MoveMembers
  ),
  async run(i) {
    if (!(await requireVoiceMod(i))) return;
    return i.reply({ ...locksView(i.guild, userLang(i)), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  },
};

export const lockComponent: ComponentHandler = async (i, [action]) => {
  if (action !== 'unlock' || !i.isStringSelectMenu() || !(await requireVoiceMod(i))) return;
  const by = i.user.username;
  for (const id of i.values) {
    if (!locks.has(id)) continue;
    unlock(id);
    logTo(i.guild, `🔓 **${by}** unlocked <#${id}>`, `🔓 **${by}** a déverrouillé <#${id}>`);
  }
  return i.update(locksView(i.guild, userLang(i)));
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
