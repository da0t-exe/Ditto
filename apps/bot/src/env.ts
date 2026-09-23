import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

/** Repository root: .env and data/ live there, whatever directory the bot is started from. */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

dotenv.config({ path: path.join(ROOT, '.env') });

export const env = {
  token: process.env.BOT_TOKEN?.trim() ?? '',
  ownerId: process.env.OWNER_ID?.trim() || null,
  /** Only run on these servers (empty = all). */
  guildIds: (process.env.GUILD_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  dataDir: process.env.DATA_DIR?.trim() || path.join(ROOT, 'data'),
};
