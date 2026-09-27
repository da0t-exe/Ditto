import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { env } from '../env.js';

fs.mkdirSync(env.dataDir, { recursive: true });

export const db = new Database(path.join(env.dataDir, 'ditto.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS guild_config (
    guild_id TEXT PRIMARY KEY,
    data     TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS captcha_state (
    guild_id     TEXT NOT NULL,
    user_id      TEXT NOT NULL,
    failures     INTEGER NOT NULL DEFAULT 0,
    locked_until INTEGER NOT NULL DEFAULT 0,
    verified_at  INTEGER,
    PRIMARY KEY (guild_id, user_id)
  );

  -- Fingerprint of every grid already shown: none is served twice.
  CREATE TABLE IF NOT EXISTS captcha_grids (
    hash       TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS captcha_usage (
    image_id  TEXT PRIMARY KEY,
    uses      INTEGER NOT NULL DEFAULT 0,
    last_used INTEGER NOT NULL DEFAULT 0
  );

  -- Arrivals, passes and misses, for the dashboard.
  CREATE TABLE IF NOT EXISTS captcha_log (
    guild_id TEXT NOT NULL,
    user_id  TEXT NOT NULL,
    event    TEXT NOT NULL,
    at       INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS captcha_log_guild_at ON captcha_log (guild_id, at);

  -- Dashboard logins: only a hash of each token is kept.
  CREATE TABLE IF NOT EXISTS dashboard_sessions (
    token_hash TEXT PRIMARY KEY,
    guild_id   TEXT,
    user_id    TEXT,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS voice_locks (
    channel_id TEXT PRIMARY KEY,
    guild_id   TEXT NOT NULL,
    members    TEXT NOT NULL,
    expires_at INTEGER,
    created_by TEXT
  );

  CREATE TABLE IF NOT EXISTS rooms (
    channel_id TEXT PRIMARY KEY,
    guild_id   TEXT NOT NULL,
    defaults   TEXT NOT NULL,
    owner_id   TEXT
  );
`);

// Added in 0.6: the name shown in the logs for logins made from the Pterodactyl panel.
const sessionColumns = db.prepare<[], { name: string }>('PRAGMA table_info(dashboard_sessions)').all();
if (!sessionColumns.some((c) => c.name === 'label')) db.exec('ALTER TABLE dashboard_sessions ADD COLUMN label TEXT');
