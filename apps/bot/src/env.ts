import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

/** Racine du dépôt : le .env et data/ y vivent, quel que soit le dossier de lancement. */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

dotenv.config({ path: path.join(ROOT, '.env') });

export const env = {
  token: process.env.BOT_TOKEN?.trim() ?? '',
  ownerId: process.env.OWNER_ID?.trim() || null,
  /** Limite le bot à ces serveurs (vide = tous). */
  guildIds: (process.env.GUILD_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  dataDir: process.env.DATA_DIR?.trim() || path.join(ROOT, 'data'),
};
