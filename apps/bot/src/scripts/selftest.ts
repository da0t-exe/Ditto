/**
 * Offline check with no Discord and no download: a stand-in image pool,
 * grid generation, uniqueness, and the small helpers.
 *   DATA_DIR=<temporary folder> npm run selftest
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { env } from '../env.js';
import { parseDuration, splitEmoji } from '../core/ui.js';
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
assert.deepEqual(splitEmoji('🔴 Red'), { emoji: '🔴', label: 'Red' });
assert.deepEqual(splitEmoji('Minecraft'), { emoji: null, label: 'Minecraft' });
assert.equal(promptFor('car', 'en'), 'cars');
assert.equal(promptFor('car', 'fr'), 'des voitures');
console.log('helpers OK');

// Stand-in pool: two categories, plain tiles of different colours
const img = path.join(env.dataDir, 'captcha', 'img');
fs.mkdirSync(img, { recursive: true });
const images: { id: string; strong: string[]; weak: string[] }[] = [];
for (let n = 0; n < 60; n++) {
  const cls = n % 3 === 0 ? 'car' : n % 3 === 1 ? 'bus' : 'none';
  const color = cls === 'car' ? '#dd2e44' : cls === 'bus' ? '#fdcb58' : '#55acee';
  await sharp({ create: { width: 256, height: 256, channels: 3, background: color } })
    .jpeg()
    .toFile(path.join(img, `fake${n}.jpg`));
  images.push({ id: `fake${n}`, strong: cls === 'none' ? [] : [cls], weak: cls === 'none' ? [] : [cls] });
}
fs.writeFileSync(
  path.join(env.dataDir, 'captcha', 'manifest.json'),
  JSON.stringify({
    version: 1,
    createdAt: new Date().toISOString(),
    classes: [
      { key: 'car', count: 20 },
      { key: 'bus', count: 20 },
    ],
    images,
  })
);

const { makeGrid } = await import('../features/captcha/grid.js');
const hashes = new Set<string>();
for (let k = 0; k < 50; k++) {
  const g = await makeGrid();
  assert.equal(g.tiles.length, 9);
  assert.ok(g.answer.length >= 3 && g.answer.length <= 5, 'between 3 and 5 right tiles');
  for (const [idx, id] of g.tiles.entries()) {
    const im = images.find((x) => x.id === id)!;
    assert.equal(im.strong.includes(g.target), g.answer.includes(idx), 'answer matches the tiles');
    if (!g.answer.includes(idx)) assert.ok(!im.weak.includes(g.target), 'no ambiguous wrong tile');
  }
  assert.ok(!hashes.has(g.hash), 'grid is unique');
  hashes.add(g.hash);
  if (k === 0) {
    fs.writeFileSync(path.join(env.dataDir, 'sample-grid.jpg'), g.image);
    const meta = await sharp(g.image).metadata();
    console.log(`grid ${meta.width}x${meta.height}, ${g.image.length} bytes, target « ${promptFor(g.target, 'en')} », answer ${g.answer.map((n) => n + 1)}`);
  }
}
console.log('50 unique, consistent grids OK');
