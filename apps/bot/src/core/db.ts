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
