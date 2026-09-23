/**
 * Starts the embedded Lavalink exactly like the bot does and asks it to load a few
 * sources, without Discord. Downloads Java, Lavalink and yt-dlp on the first run.
 *   DATA_DIR=<folder> npx tsx src/scripts/lavalink-check.ts
 */
import { startLavalink } from '../features/music/lavalink.js';
import { searchMusic } from '../features/music/search.js';
import { directAudioUrl, downloadAudio, ensureYtDlp } from '../features/music/tools.js';
import { env } from '../env.js';

const show = (label: string, v: string) => console.log(label.padEnd(26), v);

console.log('data:', env.dataDir);
const t0 = Date.now();
const node = await startLavalink(() => true);
show('Lavalink started', `${Math.round((Date.now() - t0) / 1000)} s`);

async function load(identifier: string) {
  const res = await fetch(`http://${node.host}:${node.port}/v4/loadtracks?identifier=${encodeURIComponent(identifier)}`, {
    headers: { Authorization: node.password },
  });
  const r: any = await res.json();
  const t = r.loadType === 'track' ? r.data : r.loadType === 'search' ? r.data[0] : r.data?.tracks?.[0];
  return t ? `${r.loadType}: ${t.info.title} — ${t.info.author} (${Math.round(t.info.length / 1000)} s, ${t.info.sourceName})` : `${r.loadType}: ${JSON.stringify(r.data).slice(0, 160)}`;
}

const [song] = await searchMusic('rick astley never gonna give you up', 1);
const cases: [string, string][] = [
  ['YouTube', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'],
  ['YouTube Music (search hit)', song.url],
  ['SoundCloud', 'https://soundcloud.com/forss/flickermood'],
];
for (const [label, url] of cases) {
  try {
    show(label, await load(url));
  } catch (err) {
    show(label, `failed: ${(err as Error).message}`);
  }
}

await ensureYtDlp();
try {
  show('yt-dlp direct URL', await load(await directAudioUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')));
} catch (err) {
  show('yt-dlp direct URL', `failed: ${(err as Error).message}`);
}
try {
  const file = await downloadAudio('https://soundcloud.com/forss/flickermood');
  show('yt-dlp download + local', await load(file));
} catch (err) {
  show('yt-dlp download + local', `failed: ${(err as Error).message}`);
}
process.exit(0);
