import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../core/db.js';
import { env } from '../env.js';

/**
 * Two ways in:
 * - the admin password (DASHBOARD_PASSWORD, or one generated on first start and kept
 *   in data/dashboard.json): every server;
 * - a one-time link from /dashboard in Discord: that server only, for its staff.
 * Either gives a session token the page keeps; only a hash of it is stored.
 */
const FILE = path.join(env.dataDir, 'dashboard.json');
const ADMIN_TTL = 30 * 24 * 3600_000;
const STAFF_TTL = 7 * 24 * 3600_000;
const LINK_TTL = 10 * 60_000;

export interface Session {
  /** null for the admin: every server. */
  guildId: string | null;
  userId: string | null;
}

const hash = (token: string) => crypto.createHash('sha256').update(token).digest('hex');
const token = () => crypto.randomBytes(32).toString('base64url');

/** The admin password, generated and saved the first time if none is set. */
export function adminPassword(): { password: string; generated: boolean } {
  if (env.dashboardPassword) return { password: env.dashboardPassword, generated: false };
  try {
    const saved = JSON.parse(fs.readFileSync(FILE, 'utf8')) as { password?: string };
    if (saved.password) return { password: saved.password, generated: true };
  } catch {
    /* first start */
  }
  const password = crypto.randomBytes(9).toString('base64url');
  fs.writeFileSync(FILE, JSON.stringify({ password }, null, 2), { mode: 0o600 });
  return { password, generated: true };
}

function same(a: string, b: string) {
  const x = crypto.createHash('sha256').update(a).digest();
  const y = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(x, y);
}

const insert = db.prepare('INSERT INTO dashboard_sessions (token_hash, guild_id, user_id, expires_at) VALUES (?, ?, ?, ?)');
const select = db.prepare<[string, number], { guild_id: string | null; user_id: string | null }>(
  'SELECT guild_id, user_id FROM dashboard_sessions WHERE token_hash = ? AND expires_at > ?'
);
const remove = db.prepare('DELETE FROM dashboard_sessions WHERE token_hash = ?');
db.prepare('DELETE FROM dashboard_sessions WHERE expires_at < ?').run(Date.now());

function openSession(s: Session) {
  const t = token();
  insert.run(hash(t), s.guildId, s.userId, Date.now() + (s.guildId ? STAFF_TTL : ADMIN_TTL));
  return t;
}

export function loginWithPassword(password: string) {
  return same(password, adminPassword().password) ? openSession({ guildId: null, userId: null }) : null;
}

// One-time links from /dashboard.
const links = new Map<string, Session & { expires: number }>();

export function createLoginLink(guildId: string, userId: string) {
  const code = token();
  links.set(hash(code), { guildId, userId, expires: Date.now() + LINK_TTL });
  for (const [k, v] of links) if (v.expires < Date.now()) links.delete(k);
  return code;
}

export function loginWithLink(code: string) {
  const key = hash(code);
  const link = links.get(key);
  links.delete(key); // one use only
  if (!link || link.expires < Date.now()) return null;
  return { token: openSession(link), session: { guildId: link.guildId, userId: link.userId } };
}

export function sessionOf(t: string | null): Session | null {
  if (!t) return null;
  const row = select.get(hash(t), Date.now());
  return row ? { guildId: row.guild_id, userId: row.user_id } : null;
}

export function logout(t: string) {
  remove.run(hash(t));
}

// Password guessing: a few tries per address, then a pause.
const attempts = new Map<string, { n: number; until: number }>();

export function allowAttempt(ip: string) {
  const now = Date.now();
  const a = attempts.get(ip);
  if (!a || a.until < now) {
    attempts.set(ip, { n: 1, until: now + 10 * 60_000 });
    return true;
  }
  a.n++;
  return a.n <= 10;
}
