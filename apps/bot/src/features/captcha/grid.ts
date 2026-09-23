import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp, { type OverlayOptions } from 'sharp';
import { db } from '../../core/db.js';
import { getPool, IMG_DIR, PHOTO_SIZE, type Box, type PoolImage } from './pool.js';

/** One photo cut into a 4×4 grid, like reCAPTCHA. */
export const GRID = 4;
const CELLS = GRID * GRID;

// Squares that must be ticked, and squares where either answer is fine.
const REQUIRED_CELL_SHARE = 0.1; // the object fills at least 10 % of the square…
const REQUIRED_OBJECT_SHARE = 0.35; // …or at least 35 % of the object is in it
const OPTIONAL_CELL_SHARE = 0.01;

export interface Challenge {
  hash: string;
  /** Category key, e.g. « traffic_light ». */
  target: string;
  imageId: string;
  /** Squares (0-15, row by row) that must be ticked. */
  required: number[];
  /** Squares that may be ticked or not. */
  optional: number[];
  /** The photo with its grid lines, before the header is added. */
  photo: Buffer;
}

const usageOf = db.prepare<[string], { uses: number }>('SELECT uses FROM captcha_usage WHERE image_id = ?');
const bumpUsage = db.prepare(
  `INSERT INTO captcha_usage (image_id, uses, last_used) VALUES (?, 1, ?)
   ON CONFLICT(image_id) DO UPDATE SET uses = uses + 1, last_used = excluded.last_used`
);
const gridSeen = db.prepare<[string], { hash: string }>('SELECT hash FROM captcha_grids WHERE hash = ?');
const saveGrid = db.prepare('INSERT OR IGNORE INTO captcha_grids (hash, created_at) VALUES (?, ?)');

const rand = (min: number, max: number) => crypto.randomInt(min, max); // max excluded

/** Random pick, favouring the photos shown least. */
function pickLeastUsed(candidates: PoolImage[]): PoolImage | undefined {
  const sample = [...candidates].sort(() => Math.random() - 0.5).slice(0, 30);
  return sample
    .map((img) => ({ img, uses: usageOf.get(img.id)?.uses ?? 0 }))
    .sort((a, b) => a.uses - b.uses)[0]?.img;
}

const intersect = (a: Box, b: Box) =>
  Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
const boxArea = (b: Box) => (b[2] - b[0]) * (b[3] - b[1]);

/** Which squares contain the object, given boxes in the displayed crop (0 to 1). */
export function scoreCells(targets: Box[], fuzzy: Box[]) {
  const required: number[] = [];
  const optional: number[] = [];
  const cellArea = 1 / CELLS;
  for (let i = 0; i < CELLS; i++) {
    const c = i % GRID;
    const r = Math.floor(i / GRID);
    const cell: Box = [c / GRID, r / GRID, (c + 1) / GRID, (r + 1) / GRID];
    let isRequired = false;
    let isOptional = false;
    for (const b of targets) {
      const inter = intersect(b, cell);
      if (!inter) continue;
      if (inter / cellArea >= REQUIRED_CELL_SHARE || inter / boxArea(b) >= REQUIRED_OBJECT_SHARE) isRequired = true;
      else if (inter / cellArea >= OPTIONAL_CELL_SHARE) isOptional = true;
    }
    for (const b of fuzzy) if (intersect(b, cell) / cellArea >= OPTIONAL_CELL_SHARE * 2) isOptional = true;
    if (isRequired) required.push(i);
    else if (isOptional) optional.push(i);
  }
  return { required, optional };
}

/** Moves boxes into a crop of the stored photo, optionally mirrored. */
function transform(boxes: Box[], left: number, top: number, size: number, flip: boolean): Box[] {
  const S = PHOTO_SIZE;
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

export async function makeChallenge(): Promise<Challenge> {
  const pool = getPool();
  if (!pool || !pool.classes.length) throw new Error('POOL_MISSING');

  for (let attempt = 0; attempt < 20; attempt++) {
    const cls = pool.classes[rand(0, pool.classes.length)];
    const img = pickLeastUsed(pool.images.filter((im) => im.targets[cls.key]?.length));
    if (!img) continue;

    // A random zoom, offset and mirror: the same photo never looks the same twice.
    const size = rand(Math.round(PHOTO_SIZE * 0.8), PHOTO_SIZE + 1);
    const left = rand(0, PHOTO_SIZE - size + 1);
    const top = rand(0, PHOTO_SIZE - size + 1);
    const flip = rand(0, 2) === 1;

    const { required, optional } = scoreCells(
      transform(img.targets[cls.key], left, top, size, flip),
      transform(img.fuzzy[cls.key] ?? [], left, top, size, flip)
    );
    if (required.length < 1 || required.length > 12) continue;

    const hash = crypto.createHash('sha1').update(`${img.id}:${cls.key}:${size}:${left}:${top}:${flip}`).digest('hex');
    if (gridSeen.get(hash)) continue;

    const photo = await renderPhoto(img.id, left, top, size, flip);
    const now = Date.now();
    saveGrid.run(hash, now);
    bumpUsage.run(img.id, now);
    return { hash, target: cls.key, imageId: img.id, required, optional, photo };
  }
  throw new Error('GRID_FAILED');
}

// ---------- Drawing ----------

const WIDTH = 452;
const PAD = 10;
const PHOTO = WIDTH - PAD * 2; // 432
const LINE = 4;
const HEADER = 104;
const FOOTER = 40;
const BLUE = '#1a73e8';

const FONT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../assets/fonts');
const REGULAR = path.join(FONT_DIR, 'Roboto-Regular.ttf');
const BOLD = path.join(FONT_DIR, 'Roboto-Bold.ttf');

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function text(markup: string, fontfile: string, width: number) {
  const font = fontfile === BOLD ? 'Roboto Bold' : 'Roboto';
  return sharp({ text: { text: markup, font, fontfile, rgba: true, width, dpi: 72 } }).png().toBuffer();
}

async function renderPhoto(id: string, left: number, top: number, size: number, flip: boolean) {
  let img = sharp(path.join(IMG_DIR, `${id}.jpg`)).extract({ left, top, width: size, height: size }).resize(PHOTO, PHOTO);
  if (flip) img = img.flop();
  const photo = await img.modulate({ brightness: 0.95 + Math.random() * 0.1, saturation: 0.9 + Math.random() * 0.2 }).toBuffer();

  // White lines between the squares.
  const step = PHOTO / GRID;
  const lines: OverlayOptions[] = [];
  for (let k = 1; k < GRID; k++) {
    const at = Math.round(k * step - LINE / 2);
    const bar = (w: number, h: number) => ({ create: { width: w, height: h, channels: 4 as const, background: '#ffffff' } });
    lines.push({ input: await sharp(bar(LINE, PHOTO)).png().toBuffer(), left: at, top: 0 });
    lines.push({ input: await sharp(bar(PHOTO, LINE)).png().toBuffer(), left: 0, top: at });
  }
  return sharp(photo).composite(lines).jpeg({ quality: 86 }).toBuffer();
}

/** The final picture: blue header with the instruction, the grid, and a footer line. */
export async function renderChallenge(photo: Buffer, lead: string, target: string, footer: string, badge?: string) {
  const height = PAD + HEADER + PAD + PHOTO + FOOTER;
  const layers: OverlayOptions[] = [
    { input: await sharp({ create: { width: PHOTO, height: HEADER, channels: 4, background: BLUE } }).png().toBuffer(), left: PAD, top: PAD },
    { input: await text(`<span foreground="#ffffff" size="16pt">${esc(lead)}</span>`, REGULAR, PHOTO - 40), left: PAD + 20, top: PAD + 20 },
    {
      input: await text(`<span foreground="#ffffff" size="27pt" weight="bold">${esc(target.toUpperCase())}</span>`, BOLD, PHOTO - 40),
      left: PAD + 20,
      top: PAD + 46,
    },
    { input: photo, left: PAD, top: PAD + HEADER + PAD },
    {
      input: await text(`<span foreground="#6b7280" size="12pt">${esc(footer)}</span>`, REGULAR, PHOTO),
      left: PAD + 2,
      top: PAD + HEADER + PAD + PHOTO + 12,
    },
  ];
  if (badge) {
    layers.push({
      input: await text(`<span foreground="#ffffff" size="11pt" weight="bold">${esc(badge)}</span>`, BOLD, 120),
      left: WIDTH - PAD - 70,
      top: PAD + 10,
    });
  }
  return sharp({ create: { width: WIDTH, height, channels: 3, background: '#ffffff' } })
    .composite(layers)
    .jpeg({ quality: 90 })
    .toBuffer();
}
