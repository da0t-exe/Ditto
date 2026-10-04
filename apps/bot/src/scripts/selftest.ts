/**
 * Offline check with no Discord and no download: square scoring, the photo database,
 * challenge drawing and uniqueness, the small helpers, every message layout
 * (Discord rejects a layout with more than 40 components or a malformed section),
 * the settings and the music queue.
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
assert.equal(parseDuration('1d'), 24 * 3600_000);
assert.equal(parseDuration('abc'), null);
assert.equal(parseDuration(''), null);
// No duration at all, and durations no lock should last, are refused rather than read as « no limit ».
assert.equal(parseDuration('0'), null);
assert.equal(parseDuration('0h0m'), null);
assert.equal(parseDuration('99999999999999'), null);
assert.equal(parseDuration('400d'), null);
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

// A track's link stays one link, whatever characters its address holds.
const { trackLine } = await import('../features/music/views.js');
assert.ok(trackLine({ ...track(1), link: 'https://example.com/a_(live) b' }).endsWith('(https://example.com/a_%28live%29%20b) — Artist'));

// Links to the host or its network are refused, however the address is written.
const { assertPublicUrl } = await import('../features/music/search.js');
for (const bad of [
  'http://127.0.0.1:2333/version',
  'http://localhost/',
  'http://192.168.1.10/a.mp3',
  'http://[::1]/',
  'file:///etc/passwd',
  'http://[::ffff:127.0.0.1]:2333/version', // an IPv4 address written as IPv6
  'http://[::ffff:c0a8:101]/',
  'http://[fe90::1]/', // link-local is fe80::/10, not only fe80::
  'http://[64:ff9b::7f00:1]/',
  'http://0x7f.1/',
  'http://2130706433/',
  'http://224.0.0.1/',
  'http://169.254.169.254/latest/meta-data/',
]) {
  await assert.rejects(assertPublicUrl(bad), `${bad} is refused`);
}
for (const good of ['http://93.184.216.34/a.mp3', 'https://[2606:4700:4700::1111]/a.mp3']) await assertPublicUrl(good);
console.log('private links refused OK');

// ---------- Settings: only values Ditto knows are kept ----------

const { db } = await import('../core/db.js');
const { getConfig, DEFAULTS } = await import('../core/config.js');
const { applySetting } = await import('../features/setup.js');
assert.equal(await applySetting(guild, 'captchaAttempts', ['5']), true);
assert.equal(getConfig(G).captchaAttempts, 5);
for (const bad of [[], ['7'], ['abc'], ['']]) {
  assert.equal(await applySetting(guild, 'captchaAttempts', bad), false, `captchaAttempts ${JSON.stringify(bad)} is refused`);
  assert.equal(getConfig(G).captchaAttempts, 5, 'a refused value changes nothing');
}
assert.equal(await applySetting(guild, 'nope', ['1']), false);
// Settings damaged by an older version are read back as the defaults, and lists are not shared between servers.
db.prepare('INSERT INTO guild_config (guild_id, data) VALUES (?, ?)').run(
  '111111111111111112',
  JSON.stringify({ captchaAttempts: null, afkIdleMinutes: 'x', staffRoles: 'nope', voiceLog: 'yes', memberRole: 123, logChannel: '300000000000000001', gone: 1 })
);
const damaged = getConfig('111111111111111112');
assert.deepEqual(damaged, { ...DEFAULTS, logChannel: '300000000000000001' });
assert.notEqual(damaged.staffRoles, getConfig('111111111111111113').staffRoles);
db.prepare('INSERT INTO guild_config (guild_id, data) VALUES (?, ?)').run('111111111111111114', '{not json');
assert.deepEqual(getConfig('111111111111111114'), DEFAULTS);
console.log('settings OK');

// Log lines are grouped into messages Discord accepts.
const { chunkLines } = await import('../core/logs.js');
assert.deepEqual(chunkLines(['a', 'b'], 10), ['a\nb']);
assert.deepEqual(chunkLines(['aaaaaa', 'bbbbbb'], 10), ['aaaaaa', 'bbbbbb']);
const cut = chunkLines(['x'.repeat(50), 'ok'], 10);
assert.ok(cut.every((c) => c.length > 0 && c.length <= 10), 'no empty and no oversized message');
assert.equal(cut.length, 2);
console.log('log messages OK');

// ---------- Music player: the queue logic, with stand-ins for Lavalink and yt-dlp ----------

const { GuildMusic } = await import('../features/music/player.js');
const tick = () => new Promise((r) => setTimeout(r, 20));
const fakePlayer = () => ({
  voiceChannelId: '300000000000000002',
  paused: false,
  position: 0,
  played: [] as string[],
  /** The number Ditto gave the play now on, as Lavalink would hand it back. */
  on: 0,
  async play(o: { track: { encoded: string; userData: { ditto: number } } }) {
    this.played.push(o.track.encoded);
    this.on = o.track.userData.ditto;
  },
  async stopPlaying() {},
  async pause() {},
  async resume() {},
  async setVolume() {},
  async seek() {},
  async destroy() {},
});
function player(load: (route: string, t: { title: string }) => Promise<{ encoded: string }>) {
  const events: string[] = [];
  const lavalinkPlayer = fakePlayer();
  const m = new GuildMusic(
    guild,
    {
      onTrackStart: (x) => events.push(`start:${x.current?.title}`),
      onQueueEnd: () => events.push('end'),
      onError: (_m, t) => events.push(`error:${t.title}`),
      onDestroy: () => events.push('destroy'),
    },
    load as never
  );
  (m as any).player = lavalinkPlayer;
  return { m, events, lavalinkPlayer };
}
// A direct file on a public address: one Lavalink reads by itself, no yt-dlp involved.
const song = (title: string) => ({ ...track(0), title, source: 'web' as const, url: `http://93.184.216.34/${title}.mp3` });
// A clip that can only be downloaded: a single route.
const clip = (title: string) => ({ ...song(title), source: 'tiktok' as const });

{
  // The queue plays in order, a looped track replays without loading again, /previous goes back.
  let loads = 0;
  const { m, events, lavalinkPlayer } = player(async (_r, t) => (loads++, { encoded: `enc:${t.title}` }));
  const [a, b] = [song('A'), song('B')];
  assert.equal(await m.enqueue([a]), 0);
  assert.equal(await m.enqueue([b]), 1);
  await tick();
  assert.equal(loads, 2, 'the next track is loaded ahead of time');
  m.onEnded(lavalinkPlayer.on - 1); // the end of a track already left behind changes nothing
  await tick();
  assert.equal(m.current, a);
  m.onEnded(lavalinkPlayer.on);
  await tick();
  assert.equal(m.current, b);
  assert.equal(loads, 2, '…and not again when its turn comes');
  m.loop = 'track';
  m.onEnded(lavalinkPlayer.on);
  await tick();
  assert.deepEqual(lavalinkPlayer.played, ['enc:A', 'enc:B', 'enc:B']);
  assert.equal(loads, 2, 'a looped track replays as it is');
  m.loop = 'off';
  assert.equal(await m.previous(), 'previous');
  assert.equal(m.current, a);
  assert.deepEqual(m.queue, [b]);
  m.setVolume(Number('x'));
  assert.equal(m.volume, 60, 'a volume that is not a number is ignored');
  m.setVolume(250);
  assert.equal(m.volume, 100);
  m.onEnded(lavalinkPlayer.on);
  await tick();
  m.onEnded(lavalinkPlayer.on);
  await tick();
  assert.equal(m.current, null);
  assert.equal(events.at(-1), 'end');
  assert.ok(m.owns(lavalinkPlayer as never));
  m.destroy();
  assert.ok(!m.owns(lavalinkPlayer as never) && m.isDestroyed);
  assert.equal(events.at(-1), 'destroy');
}
{
  // A track that cannot be played is reported once, and the next one plays.
  const { m, events } = player(async (_r, t) => {
    if (t.title === 'A') throw new Error('unavailable');
    return { encoded: `enc:${t.title}` };
  });
  const [a, b] = [clip('A'), song('B')];
  await m.enqueue([a, b]);
  await tick();
  assert.deepEqual(events, ['error:A', 'start:B']);
  assert.equal(m.current, b);
  m.destroy();
}
for (const replacement of [song('B'), clip('B')]) {
  // Skipped while its only route was still loading, a track that then fails leaves the
  // one that replaced it alone: no error message, nothing taken off the air — whether
  // the replacement has several routes or, like a clip, a single one.
  let fail!: () => void;
  const held = new Promise<void>((_, reject) => (fail = () => reject(new Error('gone'))));
  const { m, events } = player(async (_r, t) => {
    if (t.title === 'A') await held;
    return { encoded: `enc:${t.title}` };
  });
  const [a, b] = [clip('A'), replacement];
  void m.enqueue([a, b]);
  await tick();
  assert.equal(m.current, a);
  m.skip();
  await tick();
  assert.equal(m.current, b);
  fail();
  await tick();
  assert.equal(m.current, b, 'the track playing now is untouched');
  assert.deepEqual(events, ['start:B']);
  assert.equal((m as any).routeIndex, 0, 'its routes are untouched too');
  m.destroy();
}
console.log('music player OK');

process.exit(0);
