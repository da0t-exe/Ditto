import fs from 'node:fs';
import path from 'node:path';
import { ChannelType, PermissionFlagsBits, type Client, type Guild } from 'discord.js';
import { applyDetection, getConfig, type GuildConfig } from '../core/config.js';
import { logTo, recentLogs } from '../core/logs.js';
import { isPrivileged } from '../core/perms.js';
import { ROOT } from '../env.js';
import { ensurePanel, verificationOn } from '../features/captcha/index.js';
import { getPool } from '../features/captcha/pool.js';
import { captchaStats } from '../features/captcha/session.js';
import { musicStatus } from '../features/music/engine.js';
import { musicOf, playIn, refreshPlayer } from '../features/music/index.js';
import type { FilterName, LoopMode } from '../features/music/player.js';
import { UserError } from '../features/music/search.js';
import { quickSetup, quickSetupMissing } from '../features/quicksetup.js';
import { applySetting } from '../features/setup.js';
import { listLocks, removeLock } from '../features/voice/lock.js';
import type { Session } from './auth.js';

const VERSION = (() => {
  try {
    return (JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { version: string }).version;
  } catch {
    return '?';
  }
})();
const startedAt = Date.now();

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

const icon = (g: Guild) => g.iconURL({ size: 128 }) ?? null;

/** Servers this session may manage. */
export function guildsFor(client: Client, s: Session) {
  const all = [...client.guilds.cache.values()];
  if (!s.guildId) return all;
  const g = client.guilds.cache.get(s.guildId);
  const member = g?.members.cache.get(s.userId ?? '');
  // Staff who lost their role lose the dashboard too.
  return g && member && isPrivileged(member) ? [g] : [];
}

export function guildOf(client: Client, s: Session, id: string) {
  const g = guildsFor(client, s).find((x) => x.id === id);
  if (!g) throw new HttpError(404, 'Server not found');
  return g;
}

export function me(client: Client, s: Session) {
  const user = s.userId ? client.users.cache.get(s.userId) : null;
  const music = musicStatus();
  return {
    admin: !s.guildId,
    user: user ? { id: user.id, name: user.displayName, avatar: user.displayAvatarURL({ size: 64 }) } : null,
    bot: {
      name: client.user?.username ?? 'Ditto',
      avatar: client.user?.displayAvatarURL({ size: 128 }) ?? null,
      version: VERSION,
      uptime: Date.now() - startedAt,
      ping: client.ws.ping,
      servers: client.guilds.cache.size,
      members: client.guilds.cache.reduce((n, g) => n + g.memberCount, 0),
      memoryMb: Math.round(process.memoryUsage().rss / 1048576),
      music: music.ready,
      photos: getPool()?.images.length ?? 0,
      invite: client.user
        ? `https://discord.com/oauth2/authorize?client_id=${client.user.id}&scope=bot+applications.commands&permissions=1099800103952`
        : null,
    },
    guilds: guildsFor(client, s).map((g) => ({
      id: g.id,
      name: g.name,
      icon: icon(g),
      members: g.memberCount,
      playing: !!musicOf(g.id)?.current,
    })),
  };
}

// ---------- One server ----------

function options(g: Guild) {
  const roles = [...g.roles.cache.values()]
    .filter((r) => r.id !== g.id && !r.managed)
    .sort((a, b) => b.position - a.position)
    .map((r) => ({ id: r.id, name: r.name, color: r.hexColor }));
  const channels = (types: ChannelType[]) =>
    [...g.channels.cache.values()]
      .filter((c) => types.includes(c.type))
      .sort((a, b) => ('position' in a && 'position' in b ? a.position - b.position : 0))
      .map((c) => ({ id: c.id, name: c.name, parent: c.parent?.name ?? null }));
  const bots = [...g.members.cache.values()].filter((m) => m.user.bot && m.id !== g.client.user.id).map((m) => ({ id: m.id, name: m.user.username }));
  return {
    roles,
    textChannels: channels([ChannelType.GuildText, ChannelType.GuildAnnouncement]),
    voiceChannels: channels([ChannelType.GuildVoice, ChannelType.GuildStageVoice]),
    bots,
  };
}

function warnings(g: Guild, cfg: GuildConfig) {
  const out: string[] = [];
  const top = g.members.me?.roles.highest;
  for (const id of [cfg.memberRole, cfg.pendingRole, cfg.quarantineRole]) {
    const r = id ? g.roles.cache.get(id) : null;
    if (r && top && top.comparePositionTo(r) <= 0)
      out.push(`Drag Ditto’s role above “${r.name}” in Server Settings → Roles, or it cannot hand it out.`);
  }
  const missing = quickSetupMissing(g);
  if (missing.length) out.push(`Ditto is missing the ${missing.join(' and ')} permission.`);
  if (!g.members.me?.permissions.has(PermissionFlagsBits.MoveMembers)) out.push('Ditto is missing the Move Members permission (voice tools).');
  return out;
}

export function musicState(g: Guild) {
  const m = musicOf(g.id);
  if (!m || (!m.current && !m.queue.length)) return null;
  const track = (t: NonNullable<typeof m.current>) => ({
    title: t.title,
    author: t.author,
    duration: t.duration,
    thumbnail: t.thumbnail,
    link: t.link,
    source: t.source,
    live: !!t.live,
    requester: g.members.cache.get(t.requesterId)?.displayName ?? null,
  });
  return {
    current: m.current ? track(m.current) : null,
    position: m.position,
    paused: m.paused,
    volume: m.volume,
    loop: m.loop,
    filter: m.filter,
    channel: m.channelId ? (g.channels.cache.get(m.channelId)?.name ?? null) : null,
    queue: m.queue.slice(0, 100).map(track),
    queueLength: m.queue.length,
  };
}

export function guildDetail(g: Guild) {
  const cfg = getConfig(g.id);
  return {
    id: g.id,
    name: g.name,
    icon: icon(g),
    members: g.memberCount,
    config: cfg,
    verification: verificationOn(cfg),
    options: options(g),
    warnings: warnings(g, cfg),
    captcha: (() => {
      const stats = captchaStats(g.id);
      const name = (id: string) => g.members.cache.get(id)?.displayName ?? g.client.users.cache.get(id)?.username ?? null;
      return { ...stats, latest: stats.latest.map((e) => ({ ...e, name: name(e.user_id) })) };
    })(),
    locks: listLocks(g.id).map((l) => ({ ...l, channel: g.channels.cache.get(l.channelId)?.name ?? l.channelId })),
    music: musicState(g),
    logs: recentLogs(g.id).slice(-100),
  };
}

/** Just what changes often, for the page to poll. */
export function guildLive(g: Guild) {
  return { music: musicState(g), logs: recentLogs(g.id).slice(-100), locks: listLocks(g.id).length };
}

// ---------- Changes ----------

const ROLE_FIELDS = new Set(['memberRole', 'pendingRole', 'quarantineRole', 'staffRoles']);
const TEXT_FIELDS = new Set(['verifyChannel', 'logChannel']);
const ALLOWED_NUMBERS: Record<string, number[]> = {
  captchaAttempts: [3, 4, 5, 6],
  captchaTimeoutMinutes: [5, 10, 30, 60],
  afkIdleMinutes: [5, 10, 15, 30, 60],
};

export async function setConfig(g: Guild, field: string, values: unknown, by: string) {
  if (!Array.isArray(values) || !values.every((v) => typeof v === 'string') || values.length > 25) throw new HttpError(400, 'Bad values');
  const ok = (v: string) => {
    if (ROLE_FIELDS.has(field)) return g.roles.cache.has(v) && v !== g.id;
    if (TEXT_FIELDS.has(field)) return g.channels.cache.get(v)?.type === ChannelType.GuildText;
    if (field === 'rooms') return g.channels.cache.get(v)?.type === ChannelType.GuildVoice;
    if (field === 'quarantineBots') return !!g.members.cache.get(v)?.user.bot;
    if (field in ALLOWED_NUMBERS) return ALLOWED_NUMBERS[field].includes(Number(v));
    if (field === 'features') return v === 'voiceLog' || v === 'autoAfk';
    return false;
  };
  if (!values.every(ok)) throw new HttpError(400, 'One of the values does not exist on this server');
  if (!(await applySetting(g, field, values))) throw new HttpError(400, 'Unknown setting');
  logTo(g, `🌐 **${by}** changed the setting \`${field}\` from the dashboard`);
  return getConfig(g.id);
}

export async function runAction(g: Guild, action: string, by: string) {
  if (action === 'quick-setup') {
    const missing = quickSetupMissing(g);
    if (missing.length) throw new HttpError(400, `Ditto needs the ${missing.join(' and ')} permission first.`);
    logTo(g, `🌐 **${by}** ran the quick setup from the dashboard`);
    return quickSetup(g);
  }
  if (action === 'panel') return { posted: await ensurePanel(g) };
  if (action === 'detect') return { filled: (await applyDetection(g)).filled };
  throw new HttpError(404, 'Unknown action');
}

export async function musicAction(g: Guild, action: string, body: Record<string, unknown>, by: string, requesterId: string) {
  if (action === 'play') {
    const query = String(body.query ?? '')
      .trim()
      .slice(0, 300);
    if (!query) throw new HttpError(400, 'Type a song name or a link');
    const current = musicOf(g.id);
    const channelId = current?.channelId ?? String(body.channelId ?? '');
    const channel = g.channels.cache.get(channelId);
    if (!channel?.isVoiceBased()) throw new HttpError(400, 'Pick a voice channel');
    try {
      const { tracks, position } = await playIn(g, channel, current?.textChannelId ?? null, query, requesterId, !!body.next);
      return { added: tracks.length, position };
    } catch (err) {
      throw new HttpError(400, err instanceof UserError ? err.message : 'Search failed, try again.');
    }
  }
  const m = musicOf(g.id);
  if (!m) throw new HttpError(400, 'Nothing is playing');
  switch (action) {
    case 'pause':
      m.pause();
      break;
    case 'resume':
      m.resume();
      break;
    case 'skip':
      m.skip();
      break;
    case 'previous':
      await m.previous();
      break;
    case 'stop':
      m.destroy();
      logTo(g, `🌐 **${by}** stopped the music (dashboard)`);
      return { stopped: true };
    case 'shuffle':
      m.shuffle();
      break;
    case 'clear':
      m.queue.length = 0;
      m.queueChanged();
      break;
    case 'volume':
      m.setVolume(Number(body.value));
      break;
    case 'loop':
      if (!['off', 'track', 'queue'].includes(String(body.value))) throw new HttpError(400, 'Bad loop mode');
      m.loop = body.value as LoopMode;
      break;
    case 'filter':
      if (!['none', 'bassboost', 'nightcore', 'vaporwave', '8d', 'karaoke'].includes(String(body.value))) throw new HttpError(400, 'Bad filter');
      await m.setFilter(body.value as FilterName);
      break;
    case 'seek': {
      const at = Number(body.value);
      if (!Number.isFinite(at) || at < 0) throw new HttpError(400, 'Bad time');
      await m.seek(at);
      break;
    }
    case 'remove': {
      const index = Number(body.value);
      if (!Number.isInteger(index) || index < 0 || index >= m.queue.length) throw new HttpError(400, 'Bad position');
      m.queue.splice(index, 1);
      m.queueChanged();
      break;
    }
    default:
      throw new HttpError(404, 'Unknown action');
  }
  if (['skip', 'previous', 'shuffle', 'clear'].includes(action)) logTo(g, `🌐 **${by}** — music: ${action} (dashboard)`);
  void refreshPlayer(m);
  return musicState(g);
}

export function unlock(g: Guild, channelId: string, by: string) {
  if (!removeLock(g, channelId, by)) throw new HttpError(404, 'This channel is not locked');
  return { unlocked: true };
}
