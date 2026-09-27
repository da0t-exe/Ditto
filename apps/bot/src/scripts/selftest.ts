/**
 * Offline check with no Discord and no download: square scoring, the photo database,
 * challenge drawing and uniqueness, the small helpers, and every message layout
 * (Discord rejects a layout with more than 40 components or a malformed section).
 *   npm run selftest
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChannelType, Collection, ComponentType } from 'discord.js';
import sharp from 'sharp';
import { parseDuration } from '../core/ui.js';
import { scoreCells } from '../features/captcha/cells.js';
import { promptFor } from '../features/captcha/classes.js';

// The test writes a database: into a temporary folder, never into the bot's own data/.
process.env.DATA_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), 'ditto-selftest-'));
const { env } = await import('../env.js');

// Helpers
assert.equal(parseDuration('30m'), 30 * 60_000);
assert.equal(parseDuration('2h'), 2 * 3600_000);
assert.equal(parseDuration('1h30'), 90 * 60_000);
assert.equal(parseDuration('45'), 45 * 60_000);
assert.equal(parseDuration('abc'), null);
assert.equal(promptFor('bus'), 'buses');
assert.equal(promptFor('traffic_light'), 'traffic lights');

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

// The database shipped with Ditto.
const { getPool } = await import('../features/captcha/pool.js');
const pool = getPool();
assert.ok(pool, 'the bundled photo database loads');
assert.ok(pool.classes.length >= 8, 'most categories have enough photos');
for (const im of pool.images) assert.ok(fs.existsSync(im.file), `${im.id} is on disk`);
console.log(`database OK: ${pool.images.length} photos, ${pool.classes.map((c) => `${c.key} ${c.count}`).join(', ')}`);

const { makeChallenge, nextChallenge, prepareChallenges } = await import('../features/captcha/grid.js');
const { CARD } = await import('../features/captcha/render.js');

const t0 = Date.now();
await prepareChallenges();
console.log(`stock of challenges ready in ${Date.now() - t0} ms`);
const t1 = Date.now();
const quick = await nextChallenge();
assert.ok(Date.now() - t1 < 50, 'a challenge from the stock is instant');

const hashes = new Set<string>([quick.hash]);
let none = 0;
for (let k = 0; k < 60; k++) {
  const c = await makeChallenge();
  assert.ok(c.required.length <= 12, 'at most 12 squares to tick');
  assert.ok(!c.required.some((n) => c.optional.includes(n)), 'a square is either required or optional');
  assert.ok(!hashes.has(c.hash), 'challenge is unique');
  hashes.add(c.hash);
  if (!c.required.length) none++;
  if (k === 0) {
    fs.writeFileSync(path.join(env.dataDir, 'sample-challenge.jpg'), c.image);
    const meta = await sharp(c.image).metadata();
    assert.equal(meta.width, CARD.w);
    assert.equal(meta.height, CARD.h);
    console.log(
      `challenge ${meta.width}x${meta.height}, ${Math.round(c.image.length / 1024)} KB, « ${c.target} », tick ${c.required.map((n) => n + 1)}`
    );
  }
}
console.log(`60 unique challenges OK (${none} with nothing to tick)`);

// Message layouts: built with discord.js's own validation, then checked against Discord's limits.
function count(c: any): number {
  let n = 1;
  if (Array.isArray(c.components)) n += c.components.reduce((s: number, x: any) => s + count(x), 0);
  if (c.accessory) n += count(c.accessory);
  return n;
}
function checkLayout(name: string, payload: { components: { toJSON(): unknown }[] }) {
  const json = payload.components.map((c) => c.toJSON() as any);
  const walk = (c: any) => {
    if (c.type === ComponentType.ActionRow) assert.ok(c.components.length >= 1 && c.components.length <= 5, `${name}: action row size`);
    if (c.type === ComponentType.Section) assert.ok(c.components.length >= 1 && c.components.length <= 3 && c.accessory, `${name}: section`);
    for (const x of c.components ?? []) walk(x);
    if (c.accessory) walk(c.accessory);
  };
  json.forEach(walk);
  const total = json.reduce((s, c) => s + count(c), 0);
  assert.ok(total <= 40, `${name}: ${total} components`);
}

const G = '111111111111111111';
const coll = (items: any[]) => new Collection(items.map((i) => [i.id, i] as [string, any]));
const guild: any = {
  id: G,
  name: 'Test',
  roles: {
    cache: coll([
      { id: G, name: '@everyone' },
      { id: '200000000000000004', name: 'Unverified' },
    ]),
  },
  channels: { cache: coll([{ id: '300000000000000001', name: 'verify', type: ChannelType.GuildText }]) },
  members: { cache: new Collection(), me: { roles: { highest: { comparePositionTo: () => 1 } }, permissions: { has: () => true } } },
};
const { updateConfig } = await import('../core/config.js');
updateConfig(G, { pendingRole: '200000000000000004', verifyChannel: '300000000000000001' });

const { captchaViews } = await import('../features/captcha/index.js');
const { openSession } = await import('../features/captcha/session.js');
const session = openSession(G, '400000000000000001', quick, false);
checkLayout('captcha challenge', captchaViews.challengeMessage(session, '❌ **Please try again.**'));
checkLayout('captcha panel', captchaViews.panel(guild));
checkLayout('captcha test result', captchaViews.testResultView(session, true));

const { setupViews } = await import('../features/setup.js');
for (const page of ['home', 'verify', 'quarantine', 'staff', 'voice'] as const) checkLayout(`setup ${page}`, setupViews.view(guild, page));
checkLayout('setup quick confirm', setupViews.confirmQuick(guild, 'home'));

const { playerView, queueView } = await import('../features/music/views.js');
const track = (k: number) => ({
  url: 'https://music.youtube.com/watch?v=abc',
  title: `Song ${k}`,
  author: 'Artist',
  duration: 215,
  thumbnail: 'https://i.ytimg.com/vi/abc/hqdefault.jpg',
  source: 'ytmusic' as const,
  link: 'https://music.youtube.com/watch?v=abc',
  requesterId: '400000000000000001',
});
const music: any = {
  current: track(0),
  queue: Array.from({ length: 23 }, (_, k) => track(k + 1)),
  paused: false,
  loop: 'queue',
  filter: 'nightcore',
  volume: 60,
  position: 83,
};
checkLayout('music player', playerView(music));
checkLayout('music queue', queueView(music, 2));
console.log('message layouts OK');

// Best match: the song asked for, not a remix nobody asked for.
const { matchScore } = await import('../features/music/search.js');
const original = { title: 'One More Time', author: 'Daft Punk' };
const remix = { title: 'One More Time (Remix)', author: 'Daft Punk' };
assert.ok(matchScore('daft punk one more time', original, 1) > matchScore('daft punk one more time', remix, 0));
assert.ok(matchScore('one more time remix', remix, 1) > matchScore('one more time remix', original, 0));
console.log('search ranking OK');

// Links to the host or its network are refused.
const { assertPublicUrl } = await import('../features/music/search.js');
for (const bad of ['http://127.0.0.1:2333/version', 'http://localhost/', 'http://192.168.1.10/a.mp3', 'http://[::1]/', 'file:///etc/passwd']) {
  await assert.rejects(assertPublicUrl(bad), `${bad} is refused`);
}
console.log('private links refused OK');
process.exit(0);
