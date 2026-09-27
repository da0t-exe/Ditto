/**
 * Draws a challenge exactly like a reCAPTCHA 4×4 image challenge: blue header with
 * the instruction, the photo cut into 16 squares by white lines, and the footer with
 * the reload, audio and info icons and the blue button.
 *
 * Every size and colour was measured on a real reCAPTCHA. Everything that does not
 * change between challenges is drawn once; a challenge only adds its photo and title.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp, { type OverlayOptions } from 'sharp';

export const CARD = { w: 711, h: 1074 };
/** Where the photo goes, and its size. */
export const PHOTO = { x: 16, y: 258, w: 675, h: 672 };
/** Left edge of each column and top edge of each row of squares, inside the photo. */
const COLS = [0, 170, 340, 510];
const ROWS = [0, 169, 338, 507];
const TILE = 165;

const BLUE = '#4a90e2';
const BORDER = '#d5d5d5';
const HEADER = { x: 16, y: 16, w: 678, h: 229 };
const SEPARATOR = { y: 945, h: 2, color: '#e8e8e8' };
const BUTTON = { x: 488, y: 965, w: 200, h: 85, radius: 4 };

// Text: Roboto, sized and placed to match the reference pixel for pixel.
const LEAD = { text: 'Select all squares with', size: 23.5, x: 67, y: 72 };
const TITLE = { size: 57, x: 66, y: 105, reference: 'traffic lights' };
const HINT = { text: 'If there are none, click skip', size: 28, x: 68, y: 166 };
const BUTTON_TEXT = { size: 25.5, spacing: 1, centerY: 1005 };

// Material icons (Apache 2.0), 24×24, drawn at 64 px.
const ICON_SCALE = 64 / 24;
const ICONS = [
  {
    x: 30,
    color: '#7c7c7c',
    d: 'M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z',
  },
  {
    x: 126,
    color: '#333333',
    d: 'M12 1c-4.97 0-9 4.03-9 9v7c0 1.66 1.34 3 3 3h3v-8H5v-2c0-3.87 3.13-7 7-7s7 3.13 7 7v2h-4v8h3c1.66 0 3-1.34 3-3v-7c0-4.97-4.03-9-9-9z',
  },
  {
    x: 223,
    color: '#707070',
    d: 'M11 7h2v2h-2zm0 4h2v6h-2zm1-9C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z',
  },
];
const ICON_Y = 977;

const FONT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../assets/fonts');
const REGULAR = path.join(FONT_DIR, 'Roboto-Regular.ttf');
const BOLD = path.join(FONT_DIR, 'Roboto-Bold.ttf');

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

interface Ink {
  buf: Buffer;
  w: number;
  h: number;
  /** Rows between the top of the tallest possible glyph and the first inked row. */
  top: number;
}

/** White text, cropped to its ink. */
async function ink(text: string, size: number, bold: boolean, spacing = 0): Promise<Ink> {
  const markup = `<span foreground="#ffffff" size="${size}pt" letter_spacing="${Math.round(spacing * 1024)}">${esc(text)}</span>`;
  const { data, info } = await sharp({
    text: { text: markup, font: bold ? 'Roboto Bold' : 'Roboto', fontfile: bold ? BOLD : REGULAR, rgba: true, dpi: 72 },
  })
    .raw()
    .toBuffer({ resolveWithObject: true });
  let x0 = info.width;
  let x1 = -1;
  let y0 = info.height;
  let y1 = -1;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      if (data[(y * info.width + x) * 4 + 3] > 8) {
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
    }
  }
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const buf = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
    .extract({ left: x0, top: y0, width: w, height: h })
    .png()
    .toBuffer();
  return { buf, w, h, top: y0 };
}

/**
 * A title word, positioned on a fixed baseline whatever its letters: « cars » has no
 * ascender, « traffic lights » has several. It is drawn between two bars that span the
 * font's full height, then cut out of them.
 */
async function titleInk(text: string): Promise<Ink> {
  const framed = await ink(`|${text}|`, TITLE.size, true);
  const { data, info } = await sharp(framed.buf).raw().toBuffer({ resolveWithObject: true });
  const inked = (x: number) => {
    for (let y = 0; y < info.height; y++) if (data[(y * info.width + x) * 4 + 3] > 8) return true;
    return false;
  };
  // Skip the left bar and the space after it, and the right bar and the space before it.
  let left = 0;
  while (left < info.width && inked(left)) left++;
  while (left < info.width && !inked(left)) left++;
  let right = info.width - 1;
  while (right > left && inked(right)) right--;
  while (right > left && !inked(right)) right--;
  const w = right - left + 1;
  const body = await sharp(framed.buf).extract({ left, top: 0, width: w, height: info.height }).raw().toBuffer();
  // Where the word's own ink starts, below the top of the bars.
  let top = 0;
  outer: for (; top < info.height; top++) for (let x = 0; x < w; x++) if (body[(top * w + x) * 4 + 3] > 8) break outer;
  return {
    buf: await sharp(body, { raw: { width: w, height: info.height, channels: 4 } })
      .png()
      .toBuffer(),
    w,
    h: info.height,
    top,
  };
}

let base: Promise<Buffer> | null = null;
let lines: Promise<Buffer> | null = null;
let titleTop: Promise<number> | null = null;
const titles = new Map<string, Promise<Ink>>();

/** The card without its photo and title. */
function drawBase() {
  base ??= (async () => {
    const icons = ICONS.map(
      (icon) => `<path transform="translate(${icon.x} ${ICON_Y}) scale(${ICON_SCALE})" fill="${icon.color}" d="${icon.d}"/>`
    ).join('');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD.w}" height="${CARD.h}">
      <rect x="1" y="1" width="${CARD.w - 2}" height="${CARD.h - 2}" fill="#ffffff" stroke="${BORDER}" stroke-width="2"/>
      <rect x="${HEADER.x}" y="${HEADER.y}" width="${HEADER.w}" height="${HEADER.h}" fill="${BLUE}"/>
      <rect x="2" y="${SEPARATOR.y}" width="${CARD.w - 4}" height="${SEPARATOR.h}" fill="${SEPARATOR.color}"/>
      <rect x="${BUTTON.x}" y="${BUTTON.y}" width="${BUTTON.w}" height="${BUTTON.h}" rx="${BUTTON.radius}" fill="${BLUE}"/>
      ${icons}
    </svg>`;
    const [lead, hint, skip] = await Promise.all([
      ink(LEAD.text, LEAD.size, false),
      ink(HINT.text, HINT.size, false),
      ink('SKIP', BUTTON_TEXT.size, true, BUTTON_TEXT.spacing),
    ]);
    const layers: OverlayOptions[] = [
      { input: lead.buf, left: LEAD.x, top: LEAD.y },
      { input: hint.buf, left: HINT.x, top: HINT.y },
      {
        input: skip.buf,
        left: Math.round(BUTTON.x + (BUTTON.w - skip.w) / 2),
        top: Math.round(BUTTON_TEXT.centerY - skip.h / 2),
      },
    ];
    return sharp(Buffer.from(svg)).composite(layers).png().toBuffer();
  })();
  return base;
}

/** The white lines between the squares, over the photo. */
function drawLines() {
  lines ??= (() => {
    // Gaps sit between the end of one square and the start of the next.
    const vertical = COLS.slice(1).map((x, k) => ({ at: COLS[k] + TILE, size: x - COLS[k] - TILE }));
    const horizontal = ROWS.slice(1).map((y, k) => ({ at: ROWS[k] + TILE, size: y - ROWS[k] - TILE }));
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${PHOTO.w}" height="${PHOTO.h}">
      ${vertical.map((g) => `<rect x="${g.at}" y="0" width="${g.size}" height="${PHOTO.h}" fill="#ffffff"/>`).join('')}
      ${horizontal.map((g) => `<rect x="0" y="${g.at}" width="${PHOTO.w}" height="${g.size}" fill="#ffffff"/>`).join('')}
    </svg>`;
    return sharp(Buffer.from(svg)).png().toBuffer();
  })();
  return lines;
}

/** Where titles are placed so that « traffic lights » lands exactly where reCAPTCHA puts it. */
function titleOrigin() {
  titleTop ??= titleInk(TITLE.reference).then((ref) => TITLE.y - ref.top);
  return titleTop;
}

function title(text: string) {
  let t = titles.get(text);
  if (!t) {
    t = titleInk(text);
    titles.set(text, t);
  }
  return t;
}

/**
 * The finished challenge picture. `photo` is the raw RGB photo, PHOTO.w × PHOTO.h.
 */
export async function renderCard(photo: Buffer, prompt: string): Promise<Buffer> {
  const [card, grid, word, top] = await Promise.all([drawBase(), drawLines(), title(prompt), titleOrigin()]);
  return sharp(card)
    .composite([
      { input: photo, raw: { width: PHOTO.w, height: PHOTO.h, channels: 3 }, left: PHOTO.x, top: PHOTO.y },
      { input: grid, left: PHOTO.x, top: PHOTO.y },
      { input: word.buf, left: TITLE.x, top },
    ])
    .jpeg({ quality: 86, mozjpeg: true })
    .toBuffer();
}

/** Draws everything that never changes, so the first challenge is as quick as the others. */
export async function warmUp(prompts: string[]) {
  await Promise.all([drawBase(), drawLines(), titleOrigin(), ...prompts.map(title)]);
}
