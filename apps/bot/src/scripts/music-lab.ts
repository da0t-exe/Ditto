/**
 * End-to-end music check without Discord: resolves each link like /play does, then
 * has the built-in Lavalink really play it (not only load it), route by route, and
 * reports which route worked. Lavalink starts playing a track even with no voice
 * connection, so format and stream errors show up exactly as in a voice channel.
 *   DATA_DIR=<folder> npx tsx src/scripts/music-lab.ts [link or search…]
 */
import { createRequire } from 'node:module';
import { startLavalink, type NodeConfig } from '../features/music/lavalink.js';
import { loadVia, routesFor, type Route, type Track } from '../features/music/player.js';
import { ensurePlayable, resolveInput } from '../features/music/search.js';
import { ensureYtDlp } from '../features/music/tools.js';

const WebSocket = createRequire(import.meta.url)('ws');

const CASES: [string, string][] = [
  ['YouTube (failed on the server)', 'https://www.youtube.com/watch?v=2hkJhCMQMfs'],
  ['YouTube', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'],
  ['Search → YouTube Music', 'daft punk around the world'],
  ['Search → YouTube Music', 'stromae alors on danse'],
  ['Spotify track', 'https://open.spotify.com/track/4PTG3Z6ehGkBFwjybzWkR8'],
  ['Deezer track', 'https://www.deezer.com/track/3135556'],
  ['Apple Music song', 'https://music.apple.com/us/album/never-gonna-give-you-up/1559523357?i=1559523359'],
  ['SoundCloud', 'https://soundcloud.com/forss/flickermood'],
  ['Bandcamp', 'https://c418.bandcamp.com/track/sweden'],
  ['TikTok', 'https://www.tiktok.com/@scout2015/video/6718335390845095173'],
  ['X', 'https://twitter.com/freethenipple/status/643211948184596480'],
  ['Twitch clip', 'https://clips.twitch.tv/FaintLightGullWholeWheat'],
  ['Direct MP3', 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3'],
];

const args = process.argv.slice(2);
const cases: [string, string][] = args.length ? args.map((a) => ['Custom', a]) : CASES;

const node: NodeConfig = await startLavalink(() => true);
await ensureYtDlp();

// Lavalink websocket: session id and player events.
const events: { guildId: string; type: string; message?: string }[] = [];
const sessionId: string = await new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://${node.host}:${node.port}/v4/websocket`, {
    headers: { Authorization: node.password, 'User-Id': '100000000000000000', 'Client-Name': 'ditto-lab' },
  });
  ws.on('message', (raw: Buffer) => {
    const msg = JSON.parse(String(raw));
    if (msg.op === 'ready') resolve(msg.sessionId);
    if (msg.op === 'event') events.push({ guildId: msg.guildId, type: msg.type, message: msg.exception?.message ?? msg.reason });
  });
  ws.on('error', reject);
});

const api = (path: string, method: string, body?: unknown) =>
  fetch(`http://${node.host}:${node.port}/v4/sessions/${sessionId}${path}`, {
    method,
    headers: { Authorization: node.password, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });

/** Plays for a few seconds: ok when it started and nothing broke. */
async function tryPlay(guildId: string, encoded: string) {
  events.length = 0;
  await api(`/players/${guildId}`, 'PATCH', { track: { encoded }, volume: 100 });
  const until = Date.now() + 9000;
  while (Date.now() < until) {
    const bad = events.find((e) => e.guildId === guildId && /Exception|Stuck/.test(e.type));
    if (bad) return `${bad.type}: ${bad.message ?? ''}`.slice(0, 140);
    const ended = events.find((e) => e.guildId === guildId && e.type === 'TrackEndEvent' && e.message !== 'replaced');
    if (ended) return `ended early (${ended.message})`;
    await new Promise((r) => setTimeout(r, 300));
  }
  return events.some((e) => e.guildId === guildId && e.type === 'TrackStartEvent') ? null : 'never started';
}

const rows: string[] = [];
let n = 0;
for (const [label, input] of cases) {
  const guildId = String(200000000000000000n + BigInt(n++));
  const t0 = Date.now();
  let line = '';
  try {
    const { tracks } = await resolveInput(input);
    const track: Track = { ...tracks[0], requesterId: 'lab' };
    await ensurePlayable(track);
    const tried: string[] = [];
    let worked: Route | null = null;
    for (const route of routesFor(track)) {
      const r0 = Date.now();
      try {
        const { encoded } = await loadVia(route, track);
        const problem = await tryPlay(guildId, encoded);
        if (!problem) {
          worked = route;
          tried.push(`${route} ✓ ${((Date.now() - r0) / 1000).toFixed(1)}s`);
          break;
        }
        tried.push(`${route} ✗ ${problem}`);
      } catch (err) {
        tried.push(`${route} ✗ ${(err as Error).message.slice(0, 100)}`);
      }
    }
    await api(`/players/${guildId}`, 'DELETE');
    line = `${worked ? '✅' : '❌'} ${label} — « ${track.title.slice(0, 50)} » (${((Date.now() - t0) / 1000).toFixed(1)}s)\n     ${tried.join('\n     ')}`;
  } catch (err) {
    line = `❌ ${label} — resolve failed: ${(err as Error).message.slice(0, 120)}`;
  }
  console.log(line);
  rows.push(line);
}

const passed = rows.filter((r) => r.startsWith('✅')).length;
console.log(`\n${passed}/${rows.length} played`);
process.exit(0);
