import { db } from '../../core/db.js';
import type { Grid } from './grid.js';

export const MAX_FAILURES = 3;
export const MAX_REFRESH = 3;
const SESSION_TTL = 10 * 60_000;

export interface Session {
  guildId: string;
  userId: string;
  grid: Grid;
  selected: Set<number>;
  refreshes: number;
  test: boolean;
  messageId: string | null;
  expiresAt: number;
}

const sessions = new Map<string, Session>();
const key = (guildId: string, userId: string) => `${guildId}:${userId}`;

export function openSession(guildId: string, userId: string, grid: Grid, test: boolean): Session {
  const s: Session = {
    guildId,
    userId,
    grid,
    selected: new Set(),
    refreshes: 0,
    test,
    messageId: null,
    expiresAt: Date.now() + SESSION_TTL,
  };
  sessions.set(key(guildId, userId), s);
  return s;
}

export function getSession(guildId: string, userId: string): Session | null {
  const s = sessions.get(key(guildId, userId));
  if (!s || s.expiresAt < Date.now()) {
    sessions.delete(key(guildId, userId));
    return null;
  }
  return s;
}

export function closeSession(s: Session) {
  sessions.delete(key(s.guildId, s.userId));
}

setInterval(() => {
  const now = Date.now();
  for (const [k, s] of sessions) if (s.expiresAt < now) sessions.delete(k);
}, 60_000).unref();

// ---------- Essais ratés et blocage (persistés) ----------

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
