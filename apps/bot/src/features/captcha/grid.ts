import crypto from 'node:crypto';
import path from 'node:path';
import sharp from 'sharp';
import { db } from '../../core/db.js';
import { getPool, IMG_DIR, type PoolImage } from './pool.js';

const TILE = 150;
const GAP = 6;
const PAD = 10;
const SIZE = PAD * 2 + TILE * 3 + GAP * 2;
const SOURCE = 256; // taille des images stockées

export interface Grid {
  hash: string;
  target: string;
  prompt: string;
  tiles: string[];
  /** Index (0-8) des cases à cocher. */
  answer: number[];
  image: Buffer;
}

const usageOf = db.prepare<[string], { uses: number }>('SELECT uses FROM captcha_usage WHERE image_id = ?');
const bumpUsage = db.prepare(
  `INSERT INTO captcha_usage (image_id, uses, last_used) VALUES (?, 1, ?)
   ON CONFLICT(image_id) DO UPDATE SET uses = uses + 1, last_used = excluded.last_used`
);
const gridSeen = db.prepare<[string], { hash: string }>('SELECT hash FROM captcha_grids WHERE hash = ?');
const saveGrid = db.prepare('INSERT OR IGNORE INTO captcha_grids (hash, created_at) VALUES (?, ?)');

const rand = (min: number, max: number) => crypto.randomInt(min, max); // max exclu

function shuffle<T>(items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = rand(0, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Tire au hasard, en privilégiant les images les moins montrées. */
function pickLeastUsed(candidates: PoolImage[], n: number): PoolImage[] {
  const sample = shuffle(candidates).slice(0, Math.max(n * 8, 40));
  return sample
    .map((img) => ({ img, uses: usageOf.get(img.id)?.uses ?? 0 }))
    .sort((a, b) => a.uses - b.uses)
    .slice(0, n)
    .map((x) => x.img);
}

export function poolClasses() {
  return getPool()?.classes ?? [];
}

export async function makeGrid(): Promise<Grid> {
  const pool = getPool();
  if (!pool || !pool.classes.length) throw new Error('POOL_MISSING');

  for (let attempt = 0; attempt < 12; attempt++) {
    const cls = pool.classes[rand(0, pool.classes.length)];
    const positives = pool.images.filter((im) => im.strong.includes(cls.key));
    const negatives = pool.images.filter((im) => !im.weak.includes(cls.key) && !im.strong.includes(cls.key));
    const wanted = rand(3, 6); // 3 à 5 bonnes cases
    const chosen = shuffle([...pickLeastUsed(positives, wanted), ...pickLeastUsed(negatives, 9 - wanted)]);
    if (chosen.length !== 9) continue;

    const hash = crypto
      .createHash('sha1')
      .update(`${cls.key}:${chosen.map((c) => c.id).join(',')}`)
      .digest('hex');
    if (gridSeen.get(hash)) continue;

    const image = await render(chosen);
    const now = Date.now();
    saveGrid.run(hash, now);
    for (const img of chosen) bumpUsage.run(img.id, now);

    return {
      hash,
      target: cls.key,
      prompt: cls.prompt,
      tiles: chosen.map((c) => c.id),
      answer: chosen.flatMap((im, idx) => (im.strong.includes(cls.key) ? [idx] : [])),
      image,
    };
  }
  throw new Error('GRID_FAILED');
}

/** Chaque case est recadrée, retournée et teintée au hasard : deux affichages d'une même photo diffèrent. */
async function tile(id: string): Promise<Buffer> {
  const crop = rand(224, SOURCE + 1);
  const left = rand(0, SOURCE - crop + 1);
  const top = rand(0, SOURCE - crop + 1);
  let img = sharp(path.join(IMG_DIR, `${id}.jpg`))
    .extract({ left, top, width: crop, height: crop })
    .resize(TILE, TILE);
  if (rand(0, 2)) img = img.flop();
  img = img.modulate({ brightness: 0.9 + Math.random() * 0.2, saturation: 0.85 + Math.random() * 0.3 });
  return img.toBuffer();
}

async function render(images: PoolImage[]): Promise<Buffer> {
  const tiles = await Promise.all(images.map((im) => tile(im.id)));
  return sharp({ create: { width: SIZE, height: SIZE, channels: 3, background: '#ffffff' } })
    .composite(
      tiles.map((input, i) => ({
        input,
        left: PAD + (i % 3) * (TILE + GAP),
        top: PAD + Math.floor(i / 3) * (TILE + GAP),
      }))
    )
    .jpeg({ quality: 82 })
    .toBuffer();
}
