import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { db } from '../core/db.js';
import { env } from '../env.js';

/**
 * Three ways in:
 * - the admin password (DASHBOARD_PASSWORD, or one generated on first start and kept
 *   in data/dashboard.json): every server;
 * - a one-time link from /dashboard in Discord: that server only, for its staff;
 * - on Pterodactyl, a one-time code typed in the server's console by the panel (the
 *   Luna addon): every server, like the password, which the console shows anyway.
 * Each gives a session token; only a hash of it is stored.
 */
const FILE = path.join(env.dataDir, 'dashboard.json');
const ADMIN_TTL = 30 * 24 * 3600_000;
const STAFF_TTL = 7 * 24 * 3600_000;
const PANEL_TTL = 24 * 3600_000;
const LINK_TTL = 10 * 60_000;
const CONSOLE_CODE_TTL = 60_000;

export interface Session {
  /** null for the admin: every server. */
  guildId: string | null;
  userId: string | null;
  /** Who opened it from the panel, for the logs. */
  label?: string | null;
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

const insert = db.prepare('INSERT INTO dashboard_sessions (token_hash, guild_id, user_id, label, expires_at) VALUES (?, ?, ?, ?, ?)');
const select = db.prepare<[string, number], { guild_id: string | null; user_id: string | null; label: string | null }>(
  'SELECT guild_id, user_id, label FROM dashboard_sessions WHERE token_hash = ? AND expires_at > ?'
);
const remove = db.prepare('DELETE FROM dashboard_sessions WHERE token_hash = ?');
db.prepare('DELETE FROM dashboard_sessions WHERE expires_at < ?').run(Date.now());

function openSession(s: Session) {
  const t = token();
  const ttl = s.label ? PANEL_TTL : s.guildId ? STAFF_TTL : ADMIN_TTL;
  insert.run(hash(t), s.guildId, s.userId, s.label ?? null, Date.now() + ttl);
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

// Console codes from the panel. Pterodactyl sends what is typed in a server's console
// to the bot's input, and only people with console access can type there.
export const consoleLogin = !!process.env.P_SERVER_UUID && process.env.DASHBOARD_CONSOLE_LOGIN?.trim() !== '0';
const CONSOLE_CODE = /^ditto-panel-login ([A-Za-z0-9]{32,128})$/;
const consoleCodes = new Map<string, number>();
const waiting = new Map<string, () => void>();

export function listenToConsole() {
  if (!consoleLogin) return;
  // Pterodactyl's console is a terminal that shows what is typed in it: keep the codes out of it.
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  const lines = readline.createInterface({ input: process.stdin, terminal: false });
  lines.on('line', (line) => {
    const m = CONSOLE_CODE.exec(line.trim());
    if (!m) return;
    const key = hash(m[1]);
    consoleCodes.set(key, Date.now() + CONSOLE_CODE_TTL);
    waiting.get(key)?.();
  });
}

/** Trades a code the panel typed in the console for a session. Waits a moment for it to arrive. */
export async function loginWithConsoleCode(code: string, name: string) {
  if (!consoleLogin || !/^[A-Za-z0-9]{32,128}$/.test(code)) return null;
  const key = hash(code);
  if (!consoleCodes.has(key) && waiting.size < 20) {
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        waiting.delete(key);
        resolve();
      };
      const timer = setTimeout(done, 5000);
      waiting.set(key, done);
    });
  }
  const expires = consoleCodes.get(key);
  consoleCodes.delete(key); // one use only
  for (const [k, v] of consoleCodes) if (v < Date.now()) consoleCodes.delete(k);
  if (!expires || expires < Date.now()) return null;
  const label = `${name.replace(/[^\p{L}\p{N} ._-]/gu, '').trim().slice(0, 32) || 'Someone'} (panel)`;
  return { token: openSession({ guildId: null, userId: null, label }), label };
}

export function sessionOf(t: string | null): Session | null {
  if (!t) return null;
  const row = select.get(hash(t), Date.now());
  return row ? { guildId: row.guild_id, userId: row.user_id, label: row.label } : null;
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
