import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../../env.js';
import type { Box } from './cells.js';

/** The photo database shipped with Ditto. */
export const BUNDLED_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../assets/captcha');
/** Extra photos added with `npm run captcha:fetch`. */
export const EXTRA_DIR = path.join(env.dataDir, 'captcha');
export const POOL_VERSION = 3;
/** Side of the stored square photos, in pixels. */
export const STORE_SIZE = 720;
/** A category needs this many photos to be asked. */
const MIN_CLASS = 5;

export interface PoolEntry {
  id: string;
  /** Boxes of each category's objects. */
  targets: Record<string, Box[]>;
  /** Boxes of look-alikes, per category they could be confused with. */
  fuzzy: Record<string, Box[]>;
  /** Categories a person checked are not in the photo: they can be asked, with no square to tick. */
  absent: string[];
  author?: string;
  license?: string;
  source?: string;
}

export interface Manifest {
  version: typeof POOL_VERSION;
  createdAt: string;
  images: PoolEntry[];
}

export interface PoolImage extends PoolEntry {
  file: string;
}

export interface Pool {
  images: PoolImage[];
  /** Categories with enough photos, and how many each has. */
  classes: { key: string; count: number }[];
}

export const imageFile = (dir: string, id: string) => path.join(dir, 'img', `${id}.webp`);

export function readManifest(dir: string): Manifest | null {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as Manifest;
    return m.version === POOL_VERSION ? m : null;
  } catch {
    return null;
  }
}

/**
 * Ditto 0.x built its photos into data/captcha on every start, with Open Images'
 * annotation files next to them (a few hundred MB). They are now shipped with Ditto:
 * a folder in the old format is removed to give the disk space back.
 */
export function dropOutdatedExtras() {
  const file = path.join(EXTRA_DIR, 'manifest.json');
  let version: unknown;
  try {
    version = (JSON.parse(fs.readFileSync(file, 'utf8')) as { version?: unknown }).version;
  } catch {
    return false; // nothing there, or nothing we wrote
  }
  if (version === POOL_VERSION) return false;
  for (const name of ['img', 'cache', 'manifest.json']) fs.rmSync(path.join(EXTRA_DIR, name), { recursive: true, force: true });
  return true;
}

let cached: Pool | null | undefined;

/** The bundled photos plus any extra ones, or null if there are none. */
export function getPool(): Pool | null {
  if (cached !== undefined) return cached;
  const images = new Map<string, PoolImage>();
  for (const dir of [BUNDLED_DIR, EXTRA_DIR]) {
    for (const im of readManifest(dir)?.images ?? []) {
      const file = imageFile(dir, im.id);
      if (!images.has(im.id) && fs.existsSync(file)) images.set(im.id, { ...im, file });
    }
  }
  const counts = new Map<string, number>();
  for (const im of images.values()) for (const key of Object.keys(im.targets)) counts.set(key, (counts.get(key) ?? 0) + 1);
  const classes = [...counts].filter(([, n]) => n >= MIN_CLASS).map(([key, count]) => ({ key, count }));
  cached = images.size && classes.length ? { images: [...images.values()], classes } : null;
  return cached;
}

export function reloadPool() {
  cached = undefined;
  return getPool();
}
