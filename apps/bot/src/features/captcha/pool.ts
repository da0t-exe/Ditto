import fs from 'node:fs';
import path from 'node:path';
import { env } from '../../env.js';

export const CAPTCHA_DIR = path.join(env.dataDir, 'captcha');
export const IMG_DIR = path.join(CAPTCHA_DIR, 'img');
export const MANIFEST_FILE = path.join(CAPTCHA_DIR, 'manifest.json');

export interface PoolImage {
  id: string;
  /** Categories clearly visible: a right answer. */
  strong: string[];
  /** Categories present even if small: neither a right nor a wrong answer. */
  weak: string[];
  author?: string;
  license?: string;
  source?: string;
}

export interface Manifest {
  version: 1;
  createdAt: string;
  classes: { key: string; count: number }[];
  images: PoolImage[];
}

let cached: Manifest | null | undefined;

export function getPool(): Manifest | null {
  if (cached === undefined) {
    try {
      cached = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8')) as Manifest;
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
