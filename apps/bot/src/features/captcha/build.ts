/**
 * Builds a captcha photo database from Open Images (Google, photos under CC BY 2.0).
 *
 * Street scenes are preferred, like reCAPTCHA's: photos showing buildings, trees,
 * signs or vehicles around the object rank first, photos centred on people or with
 * objects boxed only as a group are skipped. Each photo is cropped to a square
 * around one category and stored with the box of every captcha object in it, plus
 * the categories a person checked are *not* in it (for challenges with nothing to tick).
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import sharp from 'sharp';
import { coverage, scoreCells, type Box } from './cells.js';
import { CAPTCHA_CLASSES } from './classes.js';
import { imageFile, POOL_VERSION, readManifest, STORE_SIZE, type Manifest, type PoolEntry } from './pool.js';

const BASE = 'https://storage.googleapis.com/openimages';
const SUBSETS = [
  {
    name: 'validation',
    bbox: `${BASE}/v5/validation-annotations-bbox.csv`,
    labels: `${BASE}/v5/validation-annotations-human-imagelabels-boxable.csv`,
    meta: `${BASE}/2018_04/validation/validation-images-with-rotation.csv`,
  },
  {
    name: 'test',
    bbox: `${BASE}/v5/test-annotations-bbox.csv`,
    labels: `${BASE}/v5/test-annotations-human-imagelabels-boxable.csv`,
    meta: `${BASE}/2018_04/test/test-images-with-rotation.csv`,
  },
];

/** Objects that make a photo look like a street, as in reCAPTCHA. */
const STREET = [
  'Building',
  'House',
  'Skyscraper',
  'Tower',
  'Tree',
  'Street light',
  'Traffic sign',
  'Traffic light',
  'Land vehicle',
  'Car',
  'Wheel',
  'Window',
];
const PEOPLE = ['Person', 'Man', 'Woman', 'Boy', 'Girl', 'Human face'];

const MIN_OBJECT = 0.004; // share of the original photo the object must fill
const MIN_COVER = 0.03; // share of the square the category must fill…
const MAX_COVER = 0.45; // …and at most, so most squares stay empty
const MAX_PEOPLE = 0.2; // share of the square people may fill
const MIN_SOURCE = 480; // smallest usable side, in pixels

interface RawBox {
  mid: string;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  group: boolean;
}
type Log = (msg: string) => void;

export interface BuildOptions {
  /** Where the photos and manifest.json go. */
  outDir: string;
  /** Where Open Images' annotation files are cached. */
  cacheDir: string;
  /** Photos wanted per category. */
  perClass: number;
  /** Photo ids to leave out (already in another database). */
  skip?: Set<string>;
  log?: Log;
}

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
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > 5000 ? buf : null; // Flickr answers with a small "unavailable" image
  } catch {
    return null;
  }
}

const area = (b: RawBox) => (b.x1 - b.x0) * (b.y1 - b.y0);

export async function buildPool(opts: BuildOptions): Promise<Manifest> {
  const logFn = opts.log ?? console.log;
  fs.mkdirSync(opts.cacheDir, { recursive: true });
  fs.mkdirSync(path.join(opts.outDir, 'img'), { recursive: true });

  // 1. Names → Open Images ids
  const classesFile = await download(`${BASE}/v5/class-descriptions-boxable.csv`, path.join(opts.cacheDir, 'classes.csv'), logFn);
  const midByName = new Map<string, string>();
  for await (const l of lines(classesFile)) {
    const [mid, name] = parseCsvLine(l);
    if (mid && name) midByName.set(name.trim(), mid);
  }
  const mids = (names: string[]) => names.map((n) => midByName.get(n)).filter((m): m is string => !!m);
  const classes = CAPTCHA_CLASSES.map((c) => ({ key: c.key, targetMids: mids(c.names), confuserMids: mids(c.confusers) }));
  const street = new Set(mids(STREET));
  const people = new Set(mids(PEOPLE));
  const relevant = new Set([...classes.flatMap((c) => [...c.targetMids, ...c.confuserMids]), ...street, ...people]);
  const targetMids = new Set(classes.flatMap((c) => c.targetMids));

  // Resume from what is already there.
  const kept = new Map<string, PoolEntry>();
  for (const im of readManifest(opts.outDir)?.images ?? []) if (fs.existsSync(imageFile(opts.outDir, im.id))) kept.set(im.id, im);
  const countOf = (key: string) => [...kept.values()].filter((im) => im.targets[key]?.length).length;
  const save = () => {
    const manifest: Manifest = { version: POOL_VERSION, createdAt: new Date().toISOString(), images: [...kept.values()] };
    fs.writeFileSync(path.join(opts.outDir, 'manifest.json'), JSON.stringify(manifest));
    return manifest;
  };

  for (const subset of SUBSETS) {
    const missing = classes.filter((c) => countOf(c.key) < opts.perClass);
    if (!missing.length) break;

    // 2. Boxes of the objects we care about
    const bboxFile = await download(subset.bbox, path.join(opts.cacheDir, `${subset.name}-bbox.csv`), logFn);
    const boxes = new Map<string, RawBox[]>();
    const depicted = new Set<string>();
    let header = true;
    for await (const l of lines(bboxFile)) {
      if (header) {
        header = false;
        continue;
      }
      // ImageID,Source,LabelName,Confidence,XMin,XMax,YMin,YMax,IsOccluded,IsTruncated,IsGroupOf,IsDepiction,IsInside
      const f = l.split(',');
      if (f[11] === '1') depicted.add(f[0]);
      if (!relevant.has(f[2])) continue;
      const list = boxes.get(f[0]) ?? [];
      list.push({ mid: f[2], x0: +f[4], x1: +f[5], y0: +f[6], y1: +f[7], group: f[10] === '1' });
      boxes.set(f[0], list);
    }

    // 3. Candidates per category, street scenes first
    const queue: { id: string; key: string }[] = [];
    for (const c of missing) {
      const scored: { id: string; score: number }[] = [];
      for (const [id, bs] of boxes) {
        if (kept.has(id) || opts.skip?.has(id) || depicted.has(id)) continue;
        const mine = bs.filter((b) => c.targetMids.includes(b.mid));
        if (!mine.length || mine.some((b) => b.group) || !mine.some((b) => area(b) >= MIN_OBJECT)) continue;
        // Other captcha objects boxed only as a group would make their squares wrong.
        if (bs.some((b) => b.group && targetMids.has(b.mid))) continue;
        const context = new Set(bs.filter((b) => street.has(b.mid) && !c.targetMids.includes(b.mid)).map((b) => b.mid)).size;
        const crowd = bs.filter((b) => people.has(b.mid)).reduce((s, b) => s + area(b), 0);
        scored.push({ id, score: Math.min(context, 4) - crowd * 4 + Math.random() * 0.5 });
      }
      scored.sort((a, b) => b.score - a.score);
      for (const { id } of scored.slice(0, Math.ceil((opts.perClass - countOf(c.key)) * 2.5))) queue.push({ id, key: c.key });
    }
    if (!queue.length) continue;
    const wanted = new Set(queue.map((q) => q.id));

    // 4. Categories people checked are absent, for the selected images only
    const labelsFile = await download(subset.labels, path.join(opts.cacheDir, `${subset.name}-labels.csv`), logFn);
    const absentMids = new Map<string, Set<string>>();
    for await (const l of lines(labelsFile)) {
      // ImageID,Source,LabelName,Confidence
      const f = l.split(',');
      if (f[3] !== '0' || !wanted.has(f[0]) || !targetMids.has(f[2])) continue;
      const set = absentMids.get(f[0]) ?? new Set<string>();
      set.add(f[2]);
      absentMids.set(f[0], set);
    }

    // 5. Author and licence
    const metaFile = await download(subset.meta, path.join(opts.cacheDir, `${subset.name}-meta.csv`), logFn);
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

    // 6. Download, crop, record boxes
    logFn(`${subset.name}: ${queue.length} candidate photos`);
    let done = 0;
    const worker = async () => {
      for (;;) {
        const job = queue.shift();
        if (!job) return;
        done++;
        if (done % 50 === 0) logFn(`  ${done} processed, ${kept.size} kept`);
        if (kept.has(job.id) || countOf(job.key) >= opts.perClass) continue;
        const m = meta.get(job.id);
        if (!m || (m.Rotation && Number(m.Rotation) !== 0)) continue;

        const buf =
          (await fetchImage(`https://open-images-dataset.s3.amazonaws.com/${subset.name}/${job.id}.jpg`)) ?? (await fetchImage(m.OriginalURL));
        if (!buf) continue;

        try {
          const entry = await processImage(opts.outDir, job.id, job.key, buf, boxes.get(job.id) ?? [], classes, people);
          if (!entry) continue;
          const absent = classes
            .filter((c) => c.targetMids.some((mid) => absentMids.get(job.id)?.has(mid)) && !entry.targets[c.key] && !entry.fuzzy[c.key])
            .map((c) => c.key);
          kept.set(job.id, {
            ...entry,
            absent,
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
    save();
  }

  const manifest = save();
  for (const c of classes) logFn(`  ${c.key.padEnd(14)} ${countOf(c.key)}`);
  logFn(`Database ready: ${manifest.images.length} photos in ${opts.outDir}`);
  return manifest;
}

async function processImage(
  outDir: string,
  id: string,
  key: string,
  buf: Buffer,
  raw: RawBox[],
  classes: { key: string; targetMids: string[]; confuserMids: string[] }[],
  people: Set<string>
): Promise<Omit<PoolEntry, 'absent' | 'author' | 'license' | 'source'> | null> {
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
  const inSquare = (list: RawBox[]) => list.map(toSquare).filter((b): b is Box => !!b);

  const targets: Record<string, Box[]> = {};
  const fuzzy: Record<string, Box[]> = {};
  for (const c of classes) {
    const t = inSquare(raw.filter((b) => c.targetMids.includes(b.mid)));
    const f = inSquare(raw.filter((b) => c.confuserMids.includes(b.mid)));
    if (t.length) targets[c.key] = t;
    if (f.length) fuzzy[c.key] = f;
  }

  // The category fills a fair part of the square, over a handful of squares, without a crowd in front.
  const cover = coverage(targets[key] ?? []);
  if (cover < MIN_COVER || cover > MAX_COVER) return null;
  const { required } = scoreCells(targets[key] ?? [], fuzzy[key] ?? []);
  if (required.length < 2 || required.length > 9) return null;
  if (coverage(inSquare(raw.filter((b) => people.has(b.mid)))) > MAX_PEOPLE) return null;

  await img.extract({ left, top, width: side, height: side }).resize(STORE_SIZE, STORE_SIZE).webp({ quality: 80 }).toFile(imageFile(outDir, id));

  return { id, targets, fuzzy };
}
