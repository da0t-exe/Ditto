import crypto from 'node:crypto';
import { db } from '../../core/db.js';
import type { Challenge } from './grid.js';

export const MAX_REFRESH = 5;
const SESSION_TTL = 10 * 60_000;

export interface Session {
  /** Short random id carried by the buttons: clicks on an older challenge are ignored. */
  id: string;
  guildId: string;
  userId: string;
  challenge: Challenge;
  selected: Set<number>;
  refreshes: number;
  test: boolean;
  expiresAt: number;
}

const sessions = new Map<string, Session>();
const key = (guildId: string, userId: string) => `${guildId}:${userId}`;

export function openSession(guildId: string, userId: string, challenge: Challenge, test: boolean): Session {
  const previous = sessions.get(key(guildId, userId));
  const s: Session = {
    id: crypto.randomBytes(4).toString('hex'),
    guildId,
    userId,
    challenge,
    selected: new Set(),
    // Starting over does not give new images for free.
    refreshes: previous && previous.expiresAt > Date.now() ? previous.refreshes : 0,
    test,
    expiresAt: Date.now() + SESSION_TTL,
  };
  sessions.set(key(guildId, userId), s);
  return s;
}

export function getSession(guildId: string, userId: string, id: string): Session | null {
  const s = sessions.get(key(guildId, userId));
  if (!s || s.id !== id || s.expiresAt < Date.now()) return null;
  return s;
}

/** A new picture in the same session: new id, so clicks on the old one are ignored. */
export function nextRound(s: Session, challenge: Challenge) {
  s.challenge = challenge;
  s.selected.clear();
  s.id = crypto.randomBytes(4).toString('hex');
}

export function closeSession(s: Session) {
  if (sessions.get(key(s.guildId, s.userId)) === s) sessions.delete(key(s.guildId, s.userId));
}

setInterval(() => {
  const now = Date.now();
  for (const [k, s] of sessions) if (s.expiresAt < now) sessions.delete(k);
}, 60_000).unref();

// ---------- Failed attempts and lockout (persisted) ----------

const selectState = db.prepare<[string, string], { failures: number; lockedUntil: number }>(
  'SELECT failures, locked_until AS lockedUntil FROM captcha_state WHERE guild_id = ? AND user_id = ?'
);
const upsertState = db.prepare(
  `INSERT INTO captcha_state (guild_id, user_id, failures, locked_until) VALUES (?, ?, ?, ?)
   ON CONFLICT(guild_id, user_id) DO UPDATE SET failures = excluded.failures, locked_until = excluded.locked_until`
);
const verifiedStmt = db.prepare(
  `INSERT INTO captcha_state (guild_id, user_id, failures, locked_until, verified_at) VALUES (?, ?, 0, 0, ?)
   ON CONFLICT(guild_id, user_id) DO UPDATE SET failures = 0, locked_until = 0, verified_at = excluded.verified_at`
);

export function getState(guildId: string, userId: string) {
  return selectState.get(guildId, userId) ?? { failures: 0, lockedUntil: 0 };
}

export function setState(guildId: string, userId: string, failures: number, lockedUntil: number) {
  upsertState.run(guildId, userId, failures, lockedUntil);
}

export function markVerified(guildId: string, userId: string) {
  verifiedStmt.run(guildId, userId, Date.now());
}

// ---------- History, for the dashboard ----------

export type CaptchaEvent = 'join' | 'pass' | 'fail' | 'lockout' | 'quarantine';

const insertEvent = db.prepare('INSERT INTO captcha_log (guild_id, user_id, event, at) VALUES (?, ?, ?, ?)');
db.prepare('DELETE FROM captcha_log WHERE at < ?').run(Date.now() - 90 * 24 * 3600_000);

export function record(guildId: string, userId: string, event: CaptchaEvent) {
  insertEvent.run(guildId, userId, event, Date.now());
}

const countsSince = db.prepare<[string, number], { event: CaptchaEvent; n: number }>(
  'SELECT event, COUNT(*) AS n FROM captcha_log WHERE guild_id = ? AND at >= ? GROUP BY event'
);
const perDay = db.prepare<[string, number], { day: string; event: CaptchaEvent; n: number }>(
  `SELECT strftime('%Y-%m-%d', at / 1000, 'unixepoch') AS day, event, COUNT(*) AS n
   FROM captcha_log WHERE guild_id = ? AND at >= ? GROUP BY day, event ORDER BY day`
);
const latest = db.prepare<[string], { user_id: string; event: CaptchaEvent; at: number }>(
  'SELECT user_id, event, at FROM captcha_log WHERE guild_id = ? ORDER BY at DESC LIMIT 30'
);

/** Passes, misses and arrivals over the last days, plus the latest events. */
export function captchaStats(guildId: string, days = 14) {
  const since = Date.now() - days * 24 * 3600_000;
  const totals: Record<CaptchaEvent, number> = { join: 0, pass: 0, fail: 0, lockout: 0, quarantine: 0 };
  for (const r of countsSince.all(guildId, since)) totals[r.event] = r.n;
  return { totals, days: perDay.all(guildId, since), latest: latest.all(guildId) };
}
