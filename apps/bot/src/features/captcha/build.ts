/**
 * Builds the captcha image pool from Open Images (Google, photos under CC BY 2.0).
 *
 * Only photos are kept (no drawings), cropped to a square around the object. Each
 * image records the categories that are clearly visible (a right answer) and the
 * ones present even if small (never offered as a wrong answer).
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import sharp from 'sharp';
import { CAPTCHA_CLASSES } from './classes.js';
import { CAPTCHA_DIR, IMG_DIR, MANIFEST_FILE, type Manifest, type PoolImage } from './pool.js';

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
const MIN_BOX_AREA = 0.04; // share of the original photo the object must fill to be a candidate
const STRONG = 0.08; // share of the final square to count as a right answer
const WEAK = 0.002; // below this, the object counts as absent
const MIN_CLASS = 12;
const OUT = 256;

const CACHE_DIR = path.join(CAPTCHA_DIR, 'cache');

interface Box {
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

export async function buildPool(logFn: Log = console.log): Promise<Manifest> {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.mkdirSync(IMG_DIR, { recursive: true });

  // 1. Names → Open Images ids
  const classesFile = await download(CLASSES_URL, path.join(CACHE_DIR, 'classes.csv'), logFn);
  const midByName = new Map<string, string>();
  for await (const l of lines(classesFile)) {
    const [mid, name] = parseCsvLine(l);
    if (mid && name) midByName.set(name.trim(), mid);
  }
  const mids = (names: string[]) => names.map((n) => midByName.get(n)).filter((m): m is string => !!m);
  const classes = CAPTCHA_CLASSES.map((c) => ({ ...c, targetMids: mids(c.names), confuserMids: mids(c.confusers) }));
  const relevant = new Set(classes.flatMap((c) => [...c.targetMids, ...c.confuserMids]));

  // Resume: images already processed are kept.
  const previous = new Map<string, PoolImage>();
  try {
    const old = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8')) as Manifest;
    for (const im of old.images) if (fs.existsSync(path.join(IMG_DIR, `${im.id}.jpg`))) previous.set(im.id, im);
  } catch {
    /* first build */
  }

  const kept = new Map<string, PoolImage>(previous);
  const countOf = (key: string) => [...kept.values()].filter((im) => im.strong.includes(key)).length;

  for (const subset of SUBSETS) {
    const missing = classes.filter((c) => countOf(c.key) < PER_CLASS);
    if (!missing.length) break;

    // 2. Boxes of the objects we care about
    const bboxFile = await download(subset.bbox, path.join(CACHE_DIR, `${subset.name}-bbox.csv`), logFn);
    const boxes = new Map<string, Box[]>();
    let header = true;
    for await (const l of lines(bboxFile)) {
      if (header) {
        header = false;
        continue;
      }
      // ImageID,Source,LabelName,Confidence,XMin,XMax,YMin,YMax,IsOccluded,IsTruncated,IsGroupOf,IsDepiction,IsInside
      const f = l.split(',');
      if (!relevant.has(f[2]) || f[11] === '1') continue;
      const list = boxes.get(f[0]) ?? [];
      list.push({ mid: f[2], x0: +f[4], x1: +f[5], y0: +f[6], y1: +f[7] });
      boxes.set(f[0], list);
    }

    // 3. Candidates per category
    const queue: { id: string; key: string }[] = [];
    for (const c of missing) {
      const cands = [...boxes]
        .filter(([id, bs]) => !kept.has(id) && bs.some((b) => c.targetMids.includes(b.mid) && (b.x1 - b.x0) * (b.y1 - b.y0) >= MIN_BOX_AREA))
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

    // 5. Download, crop, label
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
    version: 1,
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
  boxes: Box[],
  classes: { key: string; targetMids: string[]; confuserMids: string[] }[]
): Promise<Omit<PoolImage, 'author' | 'license' | 'source'> | null> {
  const img = sharp(buf);
  const { width: w = 0, height: h = 0 } = await img.metadata();
  if (w < 120 || h < 120) return null;

  // Square centred on the largest object of the requested category.
  const own = classes.find((c) => c.key === key)!;
  const target = boxes
    .filter((b) => own.targetMids.includes(b.mid))
    .sort((a, b) => (b.x1 - b.x0) * (b.y1 - b.y0) - (a.x1 - a.x0) * (a.y1 - a.y0))[0];
  if (!target) return null;
  const side = Math.min(w, h);
  const cx = ((target.x0 + target.x1) / 2) * w;
  const cy = ((target.y0 + target.y1) / 2) * h;
  const left = Math.round(Math.min(Math.max(cx - side / 2, 0), w - side));
  const top = Math.round(Math.min(Math.max(cy - side / 2, 0), h - side));

  const strong = new Set<string>();
  const weak = new Set<string>();
  for (const b of boxes) {
    const ix = Math.max(0, Math.min(b.x1 * w, left + side) - Math.max(b.x0 * w, left));
    const iy = Math.max(0, Math.min(b.y1 * h, top + side) - Math.max(b.y0 * h, top));
    const frac = (ix * iy) / (side * side);
    for (const c of classes) {
      if (c.targetMids.includes(b.mid)) {
        if (frac >= STRONG) strong.add(c.key);
        if (frac >= WEAK) weak.add(c.key);
      } else if (c.confuserMids.includes(b.mid) && frac >= WEAK) {
        weak.add(c.key);
      }
    }
  }
  if (!strong.has(key)) return null;

  await img
    .extract({ left, top, width: side, height: side })
    .resize(OUT, OUT)
    .jpeg({ quality: 82 })
    .toFile(path.join(IMG_DIR, `${id}.jpg`));

  return { id, strong: [...strong], weak: [...new Set([...weak, ...strong])] };
}
