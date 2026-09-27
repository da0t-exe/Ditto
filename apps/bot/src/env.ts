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
  /** The web dashboard (DASHBOARD=0 turns it off). */
  dashboard: process.env.DASHBOARD?.trim() !== '0',
  /** Pterodactyl gives each server a public port in SERVER_PORT: the dashboard uses it. */
  dashboardPort: Number(process.env.DASHBOARD_PORT?.trim() || process.env.SERVER_PORT?.trim() || 3000),
  dashboardHost: process.env.DASHBOARD_HOST?.trim() || '0.0.0.0',
  /** Public address of the dashboard, used in the links Ditto sends (e.g. https://ditto.example.com). */
  dashboardUrl: process.env.DASHBOARD_URL?.trim().replace(/\/+$/, '') || null,
  dashboardPassword: process.env.DASHBOARD_PASSWORD?.trim() || null,
};
