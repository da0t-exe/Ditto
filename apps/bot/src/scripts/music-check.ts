/**
 * Network check for the music lookups that need no yt-dlp: YouTube Music search,
 * Spotify / Apple Music / Deezer links, and lyrics.
 *   npx tsx src/scripts/music-check.ts
 */
import { findLyrics } from '../features/music/lyrics.js';
import { resolveInput, searchMusic } from '../features/music/search.js';

const show = (label: string, v: string) => console.log(label.padEnd(18), v);

const hits = await searchMusic('daft punk one more time', 3);
show('YT Music search', hits.map((h) => `${h.title} — ${h.author} (${h.duration}s)`).join(' | '));

const links: [string, string][] = [
  ['Spotify track', 'https://open.spotify.com/track/4PTG3Z6ehGkBFwjybzWkR8'],
  ['Spotify album', 'https://open.spotify.com/album/2noRn2Aes5aoNVsU6iWThc'],
  ['Apple song', 'https://music.apple.com/us/album/never-gonna-give-you-up/1559523357?i=1559523359'],
  ['Apple album', 'https://music.apple.com/us/album/3-originals/1559523357'],
  ['Deezer track', 'https://www.deezer.com/track/3135556'],
  ['Deezer album', 'https://www.deezer.com/album/302127'],
];
for (const [label, url] of links) {
  try {
    const r = await resolveInput(url);
    const t = r.tracks[0];
    const where = t.url ? `→ ${t.url}` : `(matched on play: « ${t.query} »)`;
    show(label, `${r.playlist ? `${r.playlist}, ${r.tracks.length} tracks — ` : ''}${t.title} — ${t.author} ${where}`);
  } catch (err) {
    show(label, `failed: ${(err as Error).message}`);
  }
}

const lyrics = await findLyrics('One More Time (Official Video)', 'Daft Punk');
show('Lyrics (LRCLIB)', lyrics ? `${lyrics.trackName} — ${lyrics.artistName}` : 'none');
