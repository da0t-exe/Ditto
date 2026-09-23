import { ChannelType, PermissionFlagsBits, type Guild } from 'discord.js';
import { db } from './db.js';
import { log } from './log.js';

export interface GuildConfig {
  language: 'auto' | 'en' | 'fr';
  /** Given once the captcha is passed; holds what @everyone would normally have. */
  memberRole: string | null;
  /** Held while a newcomer has not passed the captcha yet. */
  pendingRole: string | null;
  verifyChannel: string | null;
  /** Given instead of the captcha to members brought in by one of `quarantineBots`. */
  quarantineRole: string | null;
  quarantineBots: string[];
  logChannel: string | null;
  staffRoles: string[];
  /** Voice rooms that go back to their original state when they empty. */
  rooms: string[];
  voiceLog: boolean;
  autoAfk: boolean;
  afkIdleMinutes: number;
  captchaTimeoutMinutes: number;
}

const DEFAULTS: GuildConfig = {
  language: 'auto',
  memberRole: null,
  pendingRole: null,
  verifyChannel: null,
  quarantineRole: null,
  quarantineBots: [],
  logChannel: null,
  staffRoles: [],
  rooms: [],
  voiceLog: true,
  autoAfk: true,
  afkIdleMinutes: 10,
  captchaTimeoutMinutes: 10,
};

const cache = new Map<string, GuildConfig>();
const selectStmt = db.prepare<[string], { data: string }>('SELECT data FROM guild_config WHERE guild_id = ?');
const upsertStmt = db.prepare(
  'INSERT INTO guild_config (guild_id, data) VALUES (?, ?) ON CONFLICT(guild_id) DO UPDATE SET data = excluded.data'
);

export function hasConfig(guildId: string) {
  return cache.has(guildId) || !!selectStmt.get(guildId);
}

export function getConfig(guildId: string): GuildConfig {
  let cfg = cache.get(guildId);
  if (!cfg) {
    const row = selectStmt.get(guildId);
    cfg = { ...DEFAULTS, ...(row ? (JSON.parse(row.data) as Partial<GuildConfig>) : {}) };
    cache.set(guildId, cfg);
  }
  return cfg;
}

export function saveConfig(guildId: string, cfg: GuildConfig) {
  cache.set(guildId, cfg);
  upsertStmt.run(guildId, JSON.stringify(cfg));
}

export function updateConfig(guildId: string, patch: Partial<GuildConfig>) {
  const cfg = { ...getConfig(guildId), ...patch };
  saveConfig(guildId, cfg);
  return cfg;
}

/** Lower case, no accents, no emoji or punctuation: « 🔐 Vérification » → « verification ». */
const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/**
 * Guesses roles and channels from common English and French names. Only used to
 * pre-fill /setup — every value can be changed there.
 */
export async function detectConfig(guild: Guild): Promise<Partial<GuildConfig>> {
  const roles = [...guild.roles.cache.values()].filter((r) => r.id !== guild.id && !r.managed);
  const role = (re: RegExp) => roles.find((r) => re.test(norm(r.name)))?.id ?? null;
  const text = (re: RegExp) =>
    guild.channels.cache.find((c) => c.type === ChannelType.GuildText && re.test(norm(c.name)))?.id ?? null;

  // Staff: roles that carry moderation permissions (Administrator passes checks on its own).
  const MOD = [
    PermissionFlagsBits.ManageGuild,
    PermissionFlagsBits.KickMembers,
    PermissionFlagsBits.BanMembers,
    PermissionFlagsBits.ModerateMembers,
    PermissionFlagsBits.MoveMembers,
  ];
  const staffRoles = roles
    .filter((r) => !r.permissions.has(PermissionFlagsBits.Administrator) && MOD.some((p) => r.permissions.has(p, false)))
    .map((r) => r.id);

  const afk = guild.afkChannelId;
  const afkParent = afk ? guild.channels.cache.get(afk)?.parentId : null;
  const rooms = afkParent
    ? guild.channels.cache.filter((c) => c.type === ChannelType.GuildVoice && c.id !== afk && c.parentId === afkParent).map((c) => c.id)
    : [];

  const quarantineRole = role(/\b(quarantine|quarantaine)\b/);

  return {
    memberRole: role(/^(members?|membres?|verified|verifies?)$/),
    pendingRole: role(/^(unverified|pending|verification|en attente|non verifies?)$/),
    verifyChannel: text(/verif/),
    quarantineRole,
    quarantineBots: quarantineRole ? await findQuarantineBots(guild, quarantineRole) : [],
    logChannel: text(/\blogs?\b/),
    staffRoles,
    rooms,
  };
}

/** Fills only the settings that are still empty. */
export async function applyDetection(guild: Guild) {
  const found = await detectConfig(guild);
  const cfg = getConfig(guild.id);
  const patch: Partial<GuildConfig> = {};
  for (const [key, value] of Object.entries(found) as [keyof GuildConfig, unknown][]) {
    const current = cfg[key];
    const empty = current === null || (Array.isArray(current) && current.length === 0);
    const useful = value !== null && !(Array.isArray(value) && value.length === 0);
    if (empty && useful) (patch as Record<string, unknown>)[key] = value;
  }
  return { cfg: updateConfig(guild.id, patch), filled: Object.keys(patch) };
}

interface SearchResult {
  members: { member: { user: { id: string } }; join_source_type: number; inviter_id?: string | null }[];
}

/** Bots that brought in most of the members already holding the quarantine role (OAuth joins, source 1). */
async function findQuarantineBots(guild: Guild, quarantineRole: string): Promise<string[]> {
  try {
    const res = (await guild.client.rest.post(`/guilds/${guild.id}/members-search`, {
      body: { limit: 1000 },
    })) as SearchResult;
    const counts = new Map<string, number>();
    for (const m of res.members) {
      if (m.join_source_type !== 1 || !m.inviter_id) continue;
      if (!guild.members.cache.get(m.member.user.id)?.roles.cache.has(quarantineRole)) continue;
      counts.set(m.inviter_id, (counts.get(m.inviter_id) ?? 0) + 1);
    }
    return [...counts].filter(([, n]) => n >= 5).map(([id]) => id);
  } catch (err) {
    log.warn('config', `member search unavailable on ${guild.name}:`, (err as Error).message);
    return [];
  }
}
