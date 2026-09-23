import fs from 'node:fs';
import path from 'node:path';
import { env } from '../../env.js';

export const CAPTCHA_DIR = path.join(env.dataDir, 'captcha');
export const IMG_DIR = path.join(CAPTCHA_DIR, 'img');
export const MANIFEST_FILE = path.join(CAPTCHA_DIR, 'manifest.json');
export const POOL_VERSION = 2;
/** Side of the stored square photos, in pixels. */
export const PHOTO_SIZE = 512;

/** [x0, y0, x1, y1], normalised to the square photo (0 to 1). */
export type Box = [number, number, number, number];

export interface PoolImage {
  id: string;
  /** Boxes of each category's objects. */
  targets: Record<string, Box[]>;
  /** Boxes of look-alikes, per category they could be confused with. */
  fuzzy: Record<string, Box[]>;
  author?: string;
  license?: string;
  source?: string;
}

export interface Manifest {
  version: typeof POOL_VERSION;
  createdAt: string;
  classes: { key: string; count: number }[];
  images: PoolImage[];
}

let cached: Manifest | null | undefined;

/** The pool on disk, or null if missing or from an older format (it is then rebuilt). */
export function getPool(): Manifest | null {
  if (cached === undefined) {
    try {
      const m = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8')) as Manifest;
      cached = m.version === POOL_VERSION ? m : null;
    } catch {
      cached = null;
    }
  }
  return cached;
}

export function reloadPool() {
  cached = undefined;
  return getPool();
}
