/**
 * Builds the captcha photo pool from Open Images (Google, photos under CC BY 2.0).
 *
 * Each photo is cropped to a square around the objects of one category and stored
 * with the boxes of every captcha object in it, so a 4×4 grid can later tell which
 * squares contain the object. Drawings are skipped.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import sharp from 'sharp';
import { CAPTCHA_CLASSES } from './classes.js';
import { CAPTCHA_DIR, IMG_DIR, MANIFEST_FILE, PHOTO_SIZE, POOL_VERSION, type Box, type Manifest, type PoolImage } from './pool.js';

const CLASSES_URL = 'https://storage.googleapis.com/openimages/v5/class-descriptions-boxable.csv';
const SUBSETS = [
  {
    name: 'validation',
    bbox: 'https://storage.googleapis.com/openimages/v5/validation-annotations-bbox.csv',
    meta: 'https://storage.googleapis.com/openimages/2018_04/validation/validation-images-with-rotation.csv',
  },
  {
    name: 'test',
    bbox: 'https://storage.googleapis.com/openimages/v5/test-annotations-bbox.csv',
    meta: 'https://storage.googleapis.com/openimages/2018_04/test/test-images-with-rotation.csv',
  },
];

const PER_CLASS = Number(process.env.CAPTCHA_PER_CLASS ?? 150);
const MIN_OBJECT = 0.008; // share of the original photo an object must fill to count
const MIN_COVER = 0.02; // share of the final square the category must fill
const MAX_COVER = 0.75; // …and at most, so some squares stay empty
const MIN_CLASS = 12;
const MIN_SOURCE = 360; // smallest usable side, in pixels

const CACHE_DIR = path.join(CAPTCHA_DIR, 'cache');

interface RawBox {
  mid: string;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}
type Log = (msg: string) => void;

async function download(url: string, dest: string, logFn: Log) {
  if (fs.existsSync(dest)) return dest;
  logFn(`downloading ${path.basename(dest)}…`);
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`${url} -> HTTP ${res.status}`);
  const tmp = `${dest}.part`;
  await pipeline(Readable.fromWeb(res.body as never), fs.createWriteStream(tmp));
  fs.renameSync(tmp, dest);
  return dest;
}

function lines(file: string) {
  return readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
}

/** CSV with quoted fields (Flickr titles contain commas). */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

async function fetchImage(url: string | undefined): Promise<Buffer | null> {
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > 2000 ? buf : null; // Flickr answers with a small "unavailable" image
  } catch {
    return null;
  }
}

const area = (b: RawBox) => (b.x1 - b.x0) * (b.y1 - b.y0);

export async function buildPool(logFn: Log = console.log): Promise<Manifest> {
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  // 1. Names → Open Images ids
  const classesFile = await download(CLASSES_URL, path.join(CACHE_DIR, 'classes.csv'), logFn);
  const midByName = new Map<string, string>();
  for await (const l of lines(classesFile)) {
    const [mid, name] = parseCsvLine(l);
    if (mid && name) midByName.set(name.trim(), mid);
  }
  const mids = (names: string[]) => names.map((n) => midByName.get(n)).filter((m): m is string => !!m);
  const classes = CAPTCHA_CLASSES.map((c) => ({ key: c.key, targetMids: mids(c.names), confuserMids: mids(c.confusers) }));
  const relevant = new Set(classes.flatMap((c) => [...c.targetMids, ...c.confuserMids]));

  // Resume only from a pool in the current format; an older one is thrown away.
  const kept = new Map<string, PoolImage>();
  try {
    const old = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8')) as Manifest;
    if (old.version === POOL_VERSION) {
      for (const im of old.images) if (fs.existsSync(path.join(IMG_DIR, `${im.id}.jpg`))) kept.set(im.id, im);
    } else {
      fs.rmSync(IMG_DIR, { recursive: true, force: true });
    }
  } catch {
    /* first build */
  }
  fs.mkdirSync(IMG_DIR, { recursive: true });
  const countOf = (key: string) => [...kept.values()].filter((im) => im.targets[key]?.length).length;

  for (const subset of SUBSETS) {
    const missing = classes.filter((c) => countOf(c.key) < PER_CLASS);
    if (!missing.length) break;

    // 2. Boxes of the objects we care about
    const bboxFile = await download(subset.bbox, path.join(CACHE_DIR, `${subset.name}-bbox.csv`), logFn);
    const boxes = new Map<string, RawBox[]>();
    let header = true;
    for await (const l of lines(bboxFile)) {
      if (header) {
        header = false;
        continue;
      }
      // ImageID,Source,LabelName,Confidence,XMin,XMax,YMin,YMax,IsOccluded,IsTruncated,IsGroupOf,IsDepiction,IsInside
      const f = l.split(',');
      if (!relevant.has(f[2])) continue;
      const list = boxes.get(f[0]) ?? [];
      list.push({ mid: f[2], x0: +f[4], x1: +f[5], y0: +f[6], y1: +f[7] });
      if (f[11] === '1') list.push({ mid: 'depiction', x0: 0, x1: 0, y0: 0, y1: 0 });
      boxes.set(f[0], list);
    }

    // 3. Candidates per category (photos only)
    const queue: { id: string; key: string }[] = [];
    for (const c of missing) {
      const cands = [...boxes]
        .filter(
          ([id, bs]) =>
            !kept.has(id) &&
            !bs.some((b) => b.mid === 'depiction') &&
            bs.some((b) => c.targetMids.includes(b.mid) && area(b) >= MIN_OBJECT)
        )
        .map(([id]) => id)
        .sort(() => Math.random() - 0.5)
        .slice(0, Math.ceil((PER_CLASS - countOf(c.key)) * 1.6));
      for (const id of cands) queue.push({ id, key: c.key });
    }
    if (!queue.length) continue;

    // 4. Metadata (URL, author, licence) for the selected images only
    const wanted = new Set(queue.map((q) => q.id));
    const metaFile = await download(subset.meta, path.join(CACHE_DIR, `${subset.name}-meta.csv`), logFn);
    const meta = new Map<string, Record<string, string>>();
    let cols: string[] | null = null;
    for await (const l of lines(metaFile)) {
      const f = parseCsvLine(l);
      if (!cols) {
        cols = f;
        continue;
      }
      if (!wanted.has(f[0])) continue;
      meta.set(f[0], Object.fromEntries(cols.map((c, i) => [c, f[i]])));
    }

    // 5. Download, crop, record boxes
    logFn(`${subset.name}: ${queue.length} candidate images`);
    let done = 0;
    const worker = async () => {
      for (;;) {
        const job = queue.shift();
        if (!job) return;
        done++;
        if (done % 100 === 0) logFn(`  ${done} processed, ${kept.size} kept`);
        if (kept.has(job.id) || countOf(job.key) >= PER_CLASS) continue;
        const m = meta.get(job.id);
        if (!m || (m.Rotation && Number(m.Rotation) !== 0)) continue;

        const buf =
          (await fetchImage(m.Thumbnail300KURL)) ??
          (await fetchImage(`https://open-images-dataset.s3.amazonaws.com/${subset.name}/${job.id}.jpg`));
        if (!buf) continue;

        try {
          const entry = await processImage(job.id, job.key, buf, boxes.get(job.id) ?? [], classes);
          if (!entry) continue;
          kept.set(job.id, {
            ...entry,
            author: m.Author || undefined,
            license: m.License || undefined,
            source: m.OriginalLandingURL || undefined,
          });
        } catch {
          /* unreadable image */
        }
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
  }

  const counts = classes.map((c) => ({ key: c.key, count: countOf(c.key) }));
  const manifest: Manifest = {
    version: POOL_VERSION,
    createdAt: new Date().toISOString(),
    classes: counts.filter((c) => c.count >= MIN_CLASS),
    images: [...kept.values()],
  };
  fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifest));
  for (const c of counts) logFn(`  ${c.key.padEnd(14)} ${c.count}${c.count < MIN_CLASS ? ' (skipped, too few)' : ''}`);
  logFn(`Pool ready: ${manifest.images.length} images, ${manifest.classes.length} categories.`);
  return manifest;
}

async function processImage(
  id: string,
  key: string,
  buf: Buffer,
  raw: RawBox[],
  classes: { key: string; targetMids: string[]; confuserMids: string[] }[]
): Promise<Omit<PoolImage, 'author' | 'license' | 'source'> | null> {
  const img = sharp(buf);
  const { width: w = 0, height: h = 0 } = await img.metadata();
  if (Math.min(w, h) < MIN_SOURCE) return null;

  // Square centred on the objects of the requested category.
  const own = classes.find((c) => c.key === key)!;
  const mine = raw.filter((b) => own.targetMids.includes(b.mid));
  if (!mine.length) return null;
  const side = Math.min(w, h);
  const cx = ((Math.min(...mine.map((b) => b.x0)) + Math.max(...mine.map((b) => b.x1))) / 2) * w;
  const cy = ((Math.min(...mine.map((b) => b.y0)) + Math.max(...mine.map((b) => b.y1))) / 2) * h;
  const left = Math.round(Math.min(Math.max(cx - side / 2, 0), w - side));
  const top = Math.round(Math.min(Math.max(cy - side / 2, 0), h - side));

  // Boxes re-expressed in the square, clipped; slivers dropped.
  const toSquare = (b: RawBox): Box | null => {
    const x0 = Math.max(0, (b.x0 * w - left) / side);
    const x1 = Math.min(1, (b.x1 * w - left) / side);
    const y0 = Math.max(0, (b.y0 * h - top) / side);
    const y1 = Math.min(1, (b.y1 * h - top) / side);
    if (x1 - x0 <= 0.005 || y1 - y0 <= 0.005) return null;
    return [x0, y0, x1, y1].map((v) => Math.round(v * 1000) / 1000) as Box;
  };

  const targets: Record<string, Box[]> = {};
  const fuzzy: Record<string, Box[]> = {};
  for (const c of classes) {
    const t = raw.filter((b) => c.targetMids.includes(b.mid)).map(toSquare).filter((b): b is Box => !!b);
    const f = raw.filter((b) => c.confuserMids.includes(b.mid)).map(toSquare).filter((b): b is Box => !!b);
    if (t.length) targets[c.key] = t;
    if (f.length) fuzzy[c.key] = f;
  }

  // The requested category must fill a reasonable part of the square.
  const cover = coverage(targets[key] ?? []);
  if (cover < MIN_COVER || cover > MAX_COVER) return null;

  await img
    .extract({ left, top, width: side, height: side })
    .resize(PHOTO_SIZE, PHOTO_SIZE)
    .jpeg({ quality: 85 })
    .toFile(path.join(IMG_DIR, `${id}.jpg`));

  return { id, targets, fuzzy };
}

/** Share of the square covered by at least one box (sampled on a 50×50 grid). */
function coverage(boxes: Box[]) {
  let hit = 0;
  const N = 50;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const x = (i + 0.5) / N;
      const y = (j + 0.5) / N;
      if (boxes.some(([x0, y0, x1, y1]) => x >= x0 && x <= x1 && y >= y0 && y <= y1)) hit++;
    }
  }
  return hit / (N * N);
}
