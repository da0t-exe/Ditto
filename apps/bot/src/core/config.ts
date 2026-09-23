import { ChannelType, type Guild } from 'discord.js';
import { db } from './db.js';
import { log } from './log.js';
import { roleGroups } from './roleGroups.js';

export interface GuildConfig {
  membersRole: string | null;
  verifyRole: string | null;
  nopeRole: string | null;
  verifyChannel: string | null;
  logChannel: string | null;
  testChannel: string | null;
  staffRoles: string[];
  colorRoles: string[];
  gameRoles: string[];
  /** Salles vocales qui reviennent à leur état d'origine quand elles se vident. */
  rooms: string[];
  /** Bots dont les arrivées reçoivent directement le rôle nope. */
  nopeInviters: string[];
  afkIdleMinutes: number;
  voiceLog: boolean;
  captchaTimeoutMinutes: number;
}

const DEFAULTS: GuildConfig = {
  membersRole: null,
  verifyRole: null,
  nopeRole: null,
  verifyChannel: null,
  logChannel: null,
  testChannel: null,
  staffRoles: [],
  colorRoles: [],
  gameRoles: [],
  rooms: [],
  nopeInviters: [],
  afkIdleMinutes: 10,
  voiceLog: true,
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

/** Retrouve rôles et salons par leur nom (ceux posés par la refonte du serveur). */
export async function detectConfig(guild: Guild): Promise<GuildConfig> {
  const previous = getConfig(guild.id);
  const roles = [...guild.roles.cache.values()];
  const role = (test: (name: string) => boolean) => roles.find((r) => test(r.name.toLowerCase()))?.id ?? null;
  const text = (test: (name: string) => boolean) =>
    guild.channels.cache.find((c) => c.type === ChannelType.GuildText && test(c.name.toLowerCase()))?.id ?? null;

  const groups = roleGroups(guild);
  const group = (keyword: string) =>
    groups.find((g) => g.separator.name.toLowerCase().includes(keyword))?.roles.filter((r) => !r.managed).map((r) => r.id) ?? [];

  const afk = guild.afkChannelId;
  const afkParent = afk ? guild.channels.cache.get(afk)?.parentId : null;
  const rooms = guild.channels.cache
    .filter((c) => c.type === ChannelType.GuildVoice && c.id !== afk && (!afkParent || c.parentId === afkParent))
    .map((c) => c.id);

  const nopeRole = role((n) => n === 'nope');

  return {
    ...previous,
    membersRole: role((n) => n === 'membres'),
    verifyRole: role((n) => n.includes('vérification')),
    nopeRole,
    verifyChannel: text((n) => n.includes('vérification')),
    logChannel: text((n) => n.endsWith('logs')),
    testChannel: text((n) => n.includes('test-captcha')),
    staffRoles: group('staff'),
    colorRoles: group('couleur'),
    gameRoles: group('jeu'),
    rooms,
    nopeInviters: nopeRole ? await findNopeInviters(guild, nopeRole) : [],
  };
}

interface SearchResult {
  members: { member: { user: { id: string } }; join_source_type: number; inviter_id?: string | null }[];
}

/** Le bot qui a fait arriver la majorité des membres « nope » (via OAuth, source 1). */
async function findNopeInviters(guild: Guild, nopeRole: string): Promise<string[]> {
  try {
    const res = (await guild.client.rest.post(`/guilds/${guild.id}/members-search`, {
      body: { limit: 1000 },
    })) as SearchResult;
    const counts = new Map<string, number>();
    for (const m of res.members) {
      if (m.join_source_type !== 1 || !m.inviter_id) continue;
      if (!guild.members.cache.get(m.member.user.id)?.roles.cache.has(nopeRole)) continue;
      counts.set(m.inviter_id, (counts.get(m.inviter_id) ?? 0) + 1);
    }
    return [...counts].filter(([, n]) => n >= 5).map(([id]) => id);
  } catch (err) {
    log.warn('config', `recherche des membres indisponible sur ${guild.name}:`, (err as Error).message);
    return [];
  }
}
