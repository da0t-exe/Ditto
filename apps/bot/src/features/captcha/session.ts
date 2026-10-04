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

