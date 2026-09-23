/** Lyrics from LRCLIB (free, no key): https://lrclib.net */
interface LrcLibHit {
  trackName: string;
  artistName: string;
  plainLyrics: string | null;
  instrumental: boolean;
}

/** Strips « (Official Video) », « [Lyrics] », « feat. … » and the like from a video title. */
export function cleanTitle(title: string) {
  return title
    .replace(/[([][^)\]]*(official|lyric|audio|video|visuali[sz]er|clip|hd|4k|remaster)[^)\]]*[)\]]/gi, '')
    .replace(/\s+(ft\.?|feat\.?)\s.*$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export async function findLyrics(title: string, artist: string): Promise<LrcLibHit | null> {
  const params = new URLSearchParams({ track_name: cleanTitle(title) });
  if (artist) params.set('artist_name', artist.replace(/\s*-\s*Topic$/i, ''));
  const res = await fetch(`https://lrclib.net/api/search?${params}`, {
    headers: { 'User-Agent': 'Ditto Discord bot (https://github.com/da0t-exe/Ditto)' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return null;
  const hits = (await res.json()) as LrcLibHit[];
  return hits.find((h) => h.plainLyrics || h.instrumental) ?? null;
}
