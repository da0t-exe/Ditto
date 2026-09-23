/**
 * Offline check with no Discord and no download: a stand-in photo pool,
 * square scoring, challenge generation, uniqueness, and the small helpers.
 *   DATA_DIR=<temporary folder> npm run selftest
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { env } from '../env.js';
import { parseDuration } from '../core/ui.js';
import { promptFor } from '../features/captcha/classes.js';

if (!process.env.DATA_DIR) {
  console.error('Set DATA_DIR to a temporary folder (the test writes a stand-in pool there).');
  process.exit(1);
}

// Helpers
assert.equal(parseDuration('30m'), 30 * 60_000);
assert.equal(parseDuration('2h'), 2 * 3600_000);
assert.equal(parseDuration('1h30'), 90 * 60_000);
assert.equal(parseDuration('45'), 45 * 60_000);
assert.equal(parseDuration('abc'), null);
assert.equal(promptFor('bus', 'en'), 'buses');
assert.equal(promptFor('car', 'fr'), 'voitures');

const { scoreCells, makeChallenge, renderChallenge } = await import('../features/captcha/grid.js');

// A bus filling the lower-left quarter: squares 9, 10, 13, 14 (1-based) are required.
const quarter = scoreCells([[0, 0.5, 0.5, 1]], []);
assert.deepEqual(quarter.required, [8, 9, 12, 13]);
assert.deepEqual(quarter.optional, []);
// A thin sliver over the next column is optional, not required.
const sliver = scoreCells([[0, 0.5, 0.52, 1]], []);
assert.deepEqual(sliver.required, [8, 9, 12, 13]);
assert.deepEqual(sliver.optional, [10, 14]);
// A small object sitting in one square is still required there.
assert.deepEqual(scoreCells([[0.3, 0.3, 0.36, 0.4]], []).required, [5]);
console.log('square scoring OK');

// Stand-in pool: 40 photos, each with a yellow "bus" and a red "car" at random places.
const imgDir = path.join(env.dataDir, 'captcha', 'img');
fs.mkdirSync(imgDir, { recursive: true });
const images = [];
for (let n = 0; n < 40; n++) {
  const bus = [0.05 + Math.random() * 0.3, 0.1 + Math.random() * 0.3, 0.5 + Math.random() * 0.3, 0.55 + Math.random() * 0.3];
  const car = [0.55, 0.6, 0.9, 0.85];
  const px = (b: number[]) => b.map((v) => Math.round(v * 512));
  const [bx0, by0, bx1, by1] = px(bus);
  const [cx0, cy0, cx1, cy1] = px(car);
  const svg = `<svg width="512" height="512"><rect width="512" height="512" fill="#9fb8c9"/><rect y="300" width="512" height="212" fill="#555"/>
    <rect x="${bx0}" y="${by0}" width="${bx1 - bx0}" height="${by1 - by0}" rx="12" fill="#f2c230"/>
    <rect x="${cx0}" y="${cy0}" width="${cx1 - cx0}" height="${cy1 - cy0}" rx="20" fill="#d23"/></svg>`;
  await sharp(Buffer.from(svg)).jpeg().toFile(path.join(imgDir, `fake${n}.jpg`));
  images.push({ id: `fake${n}`, targets: { bus: [bus], car: [car] }, fuzzy: {} });
}
fs.writeFileSync(
  path.join(env.dataDir, 'captcha', 'manifest.json'),
  JSON.stringify({ version: 2, createdAt: new Date().toISOString(), classes: [{ key: 'bus', count: 40 }, { key: 'car', count: 40 }], images })
);

const hashes = new Set<string>();
for (let k = 0; k < 40; k++) {
  const c = await makeChallenge();
  assert.ok(c.required.length >= 1 && c.required.length <= 12, 'between 1 and 12 squares to tick');
  assert.ok(!c.required.some((n) => c.optional.includes(n)), 'a square is either required or optional');
  assert.ok(!hashes.has(c.hash), 'challenge is unique');
  hashes.add(c.hash);
  if (k === 0) {
    const picture = await renderChallenge(c.photo, 'Select all squares with', promptFor(c.target, 'en'), '3 attempts left', 'TEST');
    fs.writeFileSync(path.join(env.dataDir, 'sample-challenge.jpg'), picture);
    const meta = await sharp(picture).metadata();
    console.log(`challenge ${meta.width}x${meta.height}, ${Math.round(picture.length / 1024)} KB, « ${c.target} », tick ${c.required.map((n) => n + 1)}`);
  }
}
console.log('40 unique challenges OK');
