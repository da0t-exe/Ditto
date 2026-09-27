import crypto from 'node:crypto';
import sharp from 'sharp';
import { db } from '../../core/db.js';
import { log } from '../../core/log.js';
import { scoreCells, type Box } from './cells.js';
import { CAPTCHA_CLASSES, promptFor } from './classes.js';
import { getPool, STORE_SIZE, type PoolImage } from './pool.js';
import { PHOTO, renderCard, warmUp } from './render.js';

export interface Challenge {
  hash: string;
  /** Category key, e.g. « traffic_light ». */
  target: string;
  imageId: string;
  /** Squares (0-15, row by row) that must be ticked; empty when the answer is « skip ». */
  required: number[];
  /** Squares that may be ticked or not. */
  optional: number[];
  /** The finished picture (JPEG). */
  image: Buffer;
}

/** Share of challenges with nothing to tick, when the photos allow it. */
const NONE_SHARE = 0.12;

const usageOf = db.prepare<[string], { uses: number }>('SELECT uses FROM captcha_usage WHERE image_id = ?');
const bumpUsage = db.prepare(
  `INSERT INTO captcha_usage (image_id, uses, last_used) VALUES (?, 1, ?)
   ON CONFLICT(image_id) DO UPDATE SET uses = uses + 1, last_used = excluded.last_used`
);
const gridSeen = db.prepare<[string], { hash: string }>('SELECT hash FROM captcha_grids WHERE hash = ?');
const saveGrid = db.prepare('INSERT OR IGNORE INTO captcha_grids (hash, created_at) VALUES (?, ?)');
// Fingerprints are kept a month: long enough that nobody sees the same grid twice.
db.prepare('DELETE FROM captcha_grids WHERE created_at < ?').run(Date.now() - 30 * 24 * 3600_000);

const rand = (min: number, max: number) => crypto.randomInt(min, max); // max excluded
const pick = <T>(items: T[]) => items[rand(0, items.length)];

/** Random pick, favouring the photos shown least. */
function pickLeastUsed(candidates: PoolImage[]): PoolImage | undefined {
  const sample = [...candidates].sort(() => Math.random() - 0.5).slice(0, 30);
  return sample.map((img) => ({ img, uses: usageOf.get(img.id)?.uses ?? 0 })).sort((a, b) => a.uses - b.uses)[0]?.img;
}

/** Moves boxes into a crop of the stored photo, optionally mirrored. */
function transform(boxes: Box[], left: number, top: number, size: number, flip: boolean): Box[] {
  const S = STORE_SIZE;
  return boxes
    .map(([x0, y0, x1, y1]) => {
      let a = Math.max(0, (x0 * S - left) / size);
      let b = Math.min(1, (x1 * S - left) / size);
      const c = Math.max(0, (y0 * S - top) / size);
      const d = Math.min(1, (y1 * S - top) / size);
      if (flip) [a, b] = [1 - b, 1 - a];
      return [a, c, b, d] as Box;
    })
    .filter((b) => b[2] > b[0] && b[3] > b[1]);
}

/** Crops, mirrors and tints the photo: the same photo never looks the same twice. */
async function photoFor(img: PoolImage, left: number, top: number, size: number, flip: boolean) {
  let p = sharp(img.file).extract({ left, top, width: size, height: size }).resize(PHOTO.w, PHOTO.h, { fit: 'fill' });
  if (flip) p = p.flop();
  return p
    .modulate({ brightness: 0.95 + Math.random() * 0.1, saturation: 0.9 + Math.random() * 0.2 })
    .removeAlpha()
    .raw()
    .toBuffer();
}

export async function makeChallenge(): Promise<Challenge> {
  const pool = getPool();
  if (!pool) throw new Error('POOL_MISSING');
  const keys = new Set(pool.classes.map((c) => c.key));

  for (let attempt = 0; attempt < 25; attempt++) {
    // Now and then, a category that is not in the photo: the answer is « skip ».
    const absentFor = pool.images.filter((im) => im.absent.some((k) => keys.has(k)));
    const none = absentFor.length > 0 && Math.random() < NONE_SHARE;
    const img = none ? pickLeastUsed(absentFor) : undefined;
    const target = none && img ? pick(img.absent.filter((k) => keys.has(k))) : pick(pool.classes).key;
    const photo = img ?? pickLeastUsed(pool.images.filter((im) => im.targets[target]?.length));
    if (!photo) continue;

    const size = rand(Math.round(STORE_SIZE * 0.85), STORE_SIZE + 1);
    const left = rand(0, STORE_SIZE - size + 1);
    const top = rand(0, STORE_SIZE - size + 1);
    const flip = rand(0, 2) === 1;

    const { required, optional } = scoreCells(
      transform(photo.targets[target] ?? [], left, top, size, flip),
      transform(photo.fuzzy[target] ?? [], left, top, size, flip)
    );
    if (!none && (required.length < 1 || required.length > 12)) continue;
    if (none && (required.length || optional.length)) continue;

    const hash = crypto.createHash('sha1').update(`${photo.id}:${target}:${size}:${left}:${top}:${flip}`).digest('hex');
    if (gridSeen.get(hash)) continue;

    const image = await renderCard(await photoFor(photo, left, top, size, flip), promptFor(target));
    const now = Date.now();
    saveGrid.run(hash, now);
    bumpUsage.run(photo.id, now);
    return { hash, target, imageId: photo.id, required, optional, image };
  }
  throw new Error('GRID_FAILED');
}

// ---------- Ready-made challenges ----------
// A few challenges wait drawn in advance, so « Verify me », a miss or a new image
// answer at once instead of making people wait for a picture.

const READY = 6;
const ready: Challenge[] = [];
let filling = false;

async function refill() {
  if (filling) return;
  filling = true;
  try {
    while (ready.length < READY && getPool()) ready.push(await makeChallenge());
  } catch (err) {
    log.warn('captcha', `could not prepare a challenge: ${(err as Error).message}`);
  } finally {
    filling = false;
  }
}

/** A challenge ready to show: one from the stock when there is one, drawn now otherwise. */
export async function nextChallenge(): Promise<Challenge> {
  const c = ready.shift();
  void refill();
  return c ?? makeChallenge();
}

/** True when a challenge can be shown without drawing it first. */
export const hasReady = () => ready.length > 0;

/** Draws the parts that never change and fills the stock. */
export async function prepareChallenges() {
  await warmUp(CAPTCHA_CLASSES.map((c) => c.prompt));
  ready.length = 0;
  await refill();
}
