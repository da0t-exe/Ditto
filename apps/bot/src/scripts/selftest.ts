/**
 * Test local sans Discord ni téléchargement : fausse réserve d'images,
 * génération de grilles, unicité, et fonctions utilitaires.
 *   DATA_DIR=<dossier temporaire> npx tsx src/scripts/selftest.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { env } from '../env.js';
import { parseDuration, splitEmoji } from '../core/ui.js';

if (!process.env.DATA_DIR) {
  console.error('Définis DATA_DIR vers un dossier temporaire (le test y écrit une fausse réserve).');
  process.exit(1);
}

// Utilitaires
assert.equal(parseDuration('30m'), 30 * 60_000);
assert.equal(parseDuration('2h'), 2 * 3600_000);
assert.equal(parseDuration('1h30'), 90 * 60_000);
assert.equal(parseDuration('45'), 45 * 60_000);
assert.equal(parseDuration('abc'), null);
assert.deepEqual(splitEmoji('🔴 Rouge'), { emoji: '🔴', label: 'Rouge' });
assert.deepEqual(splitEmoji('Minecraft'), { emoji: null, label: 'Minecraft' });
console.log('utilitaires OK');

// Fausse réserve : 2 catégories, images unies de couleurs différentes
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
      { key: 'car', prompt: 'des voitures', count: 20 },
      { key: 'bus', prompt: 'des bus', count: 20 },
    ],
    images,
  })
);

const { makeGrid } = await import('../features/captcha/grid.js');
const hashes = new Set<string>();
for (let k = 0; k < 50; k++) {
  const g = await makeGrid();
  assert.equal(g.tiles.length, 9);
  assert.ok(g.answer.length >= 3 && g.answer.length <= 5, 'entre 3 et 5 bonnes cases');
  for (const [idx, id] of g.tiles.entries()) {
    const im = images.find((x) => x.id === id)!;
    assert.equal(im.strong.includes(g.target), g.answer.includes(idx), 'réponse cohérente');
    if (!g.answer.includes(idx)) assert.ok(!im.weak.includes(g.target), 'pas d’ambiguïté');
  }
  assert.ok(!hashes.has(g.hash), 'grille unique');
  hashes.add(g.hash);
  if (k === 0) {
    fs.writeFileSync(path.join(env.dataDir, 'exemple-grille.jpg'), g.image);
    const meta = await sharp(g.image).metadata();
    console.log(`grille ${meta.width}x${meta.height}, ${g.image.length} octets, cible « ${g.prompt} », réponse ${g.answer.map((n) => n + 1)}`);
  }
}
console.log('50 grilles uniques et cohérentes OK');
