import { runYtDlp } from './tools.js';

export type Source =
  | 'youtube'
  | 'ytmusic'
  | 'spotify'
  | 'apple'
  | 'deezer'
  | 'tidal'
  | 'soundcloud'
  | 'bandcamp'
  | 'tiktok'
  | 'twitch'
  | 'x'
  | 'instagram'
  | 'web';

export interface Found {
  /** What yt-dlp plays. Empty until matched, for tracks from Spotify / Apple / Deezer albums and playlists. */
  url: string;
  /** Search used to find `url` when it is still empty. */
  query?: string;
  title: string;
  author: string;
  duration: number | null;
  thumbnail: string | null;
  source: Source;
  /** Page shown in the "now playing" message. */
  link: string;
  live?: boolean;
}

export class UserError extends Error {
  constructor(
    public en: string,
    public fr: string
  ) {
    super(en);
  }
}

// ---------- Sources ----------

export function sourceOf(url: string): Source {
  let host = '';
  try {
    host = new URL(url).hostname.replace(/^www\.|^m\./, '');
  } catch {
    return 'web';
  }
  if (host === 'music.youtube.com') return 'ytmusic';
  if (/(^|\.)youtube\.com$|^youtu\.be$/.test(host)) return 'youtube';
  if (/spotify\.com$|spotify\.link$/.test(host)) return 'spotify';
  if (/music\.apple\.com$/.test(host)) return 'apple';
  if (/deezer\.com$|deezer\.page\.link$|dzr\.page\.link$/.test(host)) return 'deezer';
  if (/tidal\.com$/.test(host)) return 'tidal';
  if (/soundcloud\.com$/.test(host)) return 'soundcloud';
  if (/bandcamp\.com$/.test(host)) return 'bandcamp';
  if (/tiktok\.com$/.test(host)) return 'tiktok';
  if (/twitch\.tv$/.test(host)) return 'twitch';
  if (/^(x|twitter)\.com$/.test(host)) return 'x';
  if (/instagram\.com$/.test(host)) return 'instagram';
  return 'web';
}

export const SOURCE_LABEL: Record<Source, string> = {
  youtube: 'YouTube',
  ytmusic: 'YouTube Music',
  spotify: 'Spotify',
  apple: 'Apple Music',
  deezer: 'Deezer',
  tidal: 'Tidal',
  soundcloud: 'SoundCloud',
  bandcamp: 'Bandcamp',
  tiktok: 'TikTok',
  twitch: 'Twitch',
  x: 'X',
  instagram: 'Instagram',
  web: 'Web',
};

// ---------- YouTube Music search (the API music.youtube.com itself calls) ----------

const YTM_ENDPOINT = 'https://music.youtube.com/youtubei/v1/search';
const SONGS_ONLY = 'EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D';
const YTM_CLIENT = { clientName: 'WEB_REMIX', clientVersion: '1.20250101.01.00', hl: 'en', gl: 'US' };

type Runs = { text: string }[] | undefined;
const textOf = (runs: Runs) => (runs ?? []).map((r) => r.text).join('');

function parseDuration(text: string) {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(text.trim());
  return m ? Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}

function parseSong(node: any): Found | null {
  const r = node?.musicResponsiveListItemRenderer;
  if (!r) return null;
  const id =
    r.playlistItemData?.videoId ??
    r.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId;
  if (!/^[\w-]{11}$/.test(String(id ?? ''))) return null;
  const cols = r.flexColumns ?? [];
  const runsOf = (i: number): Runs => cols[i]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs;
  const title = textOf(runsOf(0)).trim();
  if (!title) return null;

  // « Artist • Album • 3:58 »
  const parts = textOf(runsOf(1))
    .split(' • ')
    .map((p) => p.trim())
    .filter(Boolean);
  const durIdx = parts.findIndex((p) => parseDuration(p) !== null);
  const thumbs = r.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails ?? [];
  return {
    url: `https://music.youtube.com/watch?v=${id}`,
    title,
    author: parts[0] ?? '',
    duration: durIdx >= 0 ? parseDuration(parts[durIdx]) : null,
    thumbnail: thumbs.length ? String(thumbs[thumbs.length - 1].url).replace(/=w\d+-h\d+/, '=w544-h544') : null,
    source: 'ytmusic',
    link: `https://music.youtube.com/watch?v=${id}`,
  };
}

/** Songs only — no reaction videos or ten-hour loops. */
export async function searchMusic(query: string, limit = 6, timeoutMs = 4000): Promise<Found[]> {
  const res = await fetch(YTM_ENDPOINT, {
    method: 'POST',
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://music.youtube.com',
      Referer: 'https://music.youtube.com/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
    },
    body: JSON.stringify({ context: { client: YTM_CLIENT }, query: query.slice(0, 200), params: SONGS_ONLY }),
  });
  if (!res.ok) throw new Error(`YouTube Music search: HTTP ${res.status}`);
  const json: any = await res.json();
  const sections = json?.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents ?? [];
  const out: Found[] = [];
  for (const s of sections) {
    for (const node of s.musicShelfRenderer?.contents ?? s.musicCardShelfRenderer?.contents ?? []) {
      const song = parseSong(node);
      if (song) out.push(song);
    }
  }
  return out.slice(0, limit);
}

// Autocomplete picks come back as « ytm:<id> »; keep what we already know about them.
const picked = new Map<string, { found: Found; at: number }>();
export function rememberPick(found: Found) {
  const id = new URL(found.url).searchParams.get('v');
  if (id) picked.set(id, { found, at: Date.now() });
  for (const [k, v] of picked) if (Date.now() - v.at > 10 * 60_000) picked.delete(k);
}

// ---------- yt-dlp metadata ----------

function fromInfo(info: any, fallbackUrl: string): Found {
  const url = info.webpage_url ?? info.original_url ?? info.url ?? fallbackUrl;
  return {
    url,
    title: info.track ?? info.title ?? url,
    author: info.artist ?? info.uploader ?? info.channel ?? '',
    duration: typeof info.duration === 'number' ? Math.round(info.duration) : null,
    thumbnail: info.thumbnail ?? info.thumbnails?.at?.(-1)?.url ?? null,
    source: sourceOf(url),
    link: url,
    live: !!info.is_live,
  };
}

async function ytdlpResolve(url: string): Promise<{ tracks: Found[]; playlist?: string }> {
  const info = JSON.parse(await runYtDlp(['-J', '--flat-playlist', url]));
  if (info._type === 'playlist' && Array.isArray(info.entries)) {
    const tracks = info.entries
      .filter((e: any) => e && (e.url || e.id))
      .map((e: any) => {
        const entryUrl = e.url?.startsWith('http') ? e.url : e.ie_key === 'Youtube' || /^[\w-]{11}$/.test(e.id) ? `https://www.youtube.com/watch?v=${e.id}` : e.url;
        return { ...fromInfo(e, entryUrl), url: entryUrl, link: entryUrl, source: sourceOf(entryUrl) };
      });
    return { tracks, playlist: info.title ?? undefined };
  }
  return { tracks: [fromInfo(info, url)] };
}

async function youtubeSearch(query: string): Promise<Found | null> {
  const info = JSON.parse(await runYtDlp(['-J', '--flat-playlist', `ytsearch1:${query}`]));
  const e = info.entries?.[0];
  if (!e) return null;
  const url = `https://www.youtube.com/watch?v=${e.id}`;
  return { ...fromInfo(e, url), url, link: url, source: 'youtube' };
}

/** Best match for free text: YouTube Music songs first, plain YouTube as a fallback. */
export async function findOne(query: string): Promise<Found | null> {
  try {
    const [hit] = await searchMusic(query, 1);
    if (hit) return hit;
  } catch {
    /* fall back below */
  }
  return youtubeSearch(query).catch(() => null);
}

// ---------- Streaming services ----------
// Spotify, Apple Music and Tidal only give metadata; the audio comes from the best
// YouTube Music match. Tracks inside albums and playlists are matched when they play.

const BROWSER = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
};
const NOT_FOUND = new UserError('I could not find that track on YouTube.', 'Je n’ai pas trouvé ce titre sur YouTube.');

/** A single track known by name: matched on YouTube Music now, shown with the service's own metadata. */
async function matchNow(meta: Omit<Found, 'url'>): Promise<Found> {
  const found = await findOne(`${meta.author} ${meta.title}`.trim());
  if (!found) throw NOT_FOUND;
  return { ...meta, url: found.url, duration: meta.duration ?? found.duration };
}

const lazy = (meta: Omit<Found, 'url' | 'query'>): Found => ({ ...meta, url: '', query: `${meta.author} ${meta.title}`.trim() });

/** Spotify's public embed page carries the track, or the album / playlist with its track list. */
async function spotify(url: string): Promise<{ tracks: Found[]; playlist?: string }> {
  const m = /spotify\.com\/(?:intl-[a-z]+\/)?(track|album|playlist)\/([A-Za-z0-9]+)/.exec(url);
  if (!m) throw new UserError('That Spotify link could not be read.', 'Ce lien Spotify n’a pas pu être lu.');
  const [, kind, id] = m;
  const html = await (await fetch(`https://open.spotify.com/embed/${kind}/${id}`, { headers: BROWSER, signal: AbortSignal.timeout(8000) })).text();
  const data = /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  const entity: any = data ? JSON.parse(data[1])?.props?.pageProps?.state?.data?.entity : null;
  if (!entity) throw new UserError('That Spotify link could not be read.', 'Ce lien Spotify n’a pas pu être lu.');
  const cover = entity.visualIdentity?.image?.at?.(-1)?.url ?? null;

  if (kind === 'track') {
    return {
      tracks: [
        await matchNow({
          title: entity.name ?? entity.title,
          author: (entity.artists ?? []).map((x: any) => x.name).join(', '),
          duration: entity.duration ? Math.round(entity.duration / 1000) : null,
          thumbnail: cover,
          source: 'spotify',
          link: url,
        }),
      ],
    };
  }
  const tracks = (entity.trackList ?? []).map((t: any) =>
    lazy({
      title: t.title,
      author: t.subtitle ?? '',
      duration: t.duration ? Math.round(t.duration / 1000) : null,
      thumbnail: cover,
      source: 'spotify',
      link: `https://open.spotify.com/track/${String(t.uri ?? '').split(':').pop()}`,
    })
  );
  if (!tracks.length) throw new UserError('That Spotify playlist is empty or private.', 'Cette playlist Spotify est vide ou privée.');
  return { tracks, playlist: entity.name ?? entity.title };
}

/** Apple Music via the public iTunes lookup API: songs and albums (playlists are not exposed). */
async function apple(url: string): Promise<{ tracks: Found[]; playlist?: string }> {
  const u = new URL(url);
  const trackId = u.searchParams.get('i') ?? (/\/song\/[^/]+\/(\d+)/.exec(u.pathname)?.[1] ?? null);
  const albumId = /\/album\/[^/]+\/(\d+)/.exec(u.pathname)?.[1] ?? /\/album\/(\d+)/.exec(u.pathname)?.[1] ?? null;
  const art = (r: any) => (r.artworkUrl100 ? String(r.artworkUrl100).replace('100x100bb', '600x600bb') : null);
  const meta = (r: any): Omit<Found, 'url' | 'query'> => ({
    title: r.trackName,
    author: r.artistName ?? '',
    duration: r.trackTimeMillis ? Math.round(r.trackTimeMillis / 1000) : null,
    thumbnail: art(r),
    source: 'apple',
    link: r.trackViewUrl ?? url,
  });
  const lookup = async (q: string) =>
    ((await (await fetch(`https://itunes.apple.com/lookup?${q}`, { signal: AbortSignal.timeout(8000) })).json()) as any).results ?? [];

  if (trackId) {
    const [song] = await lookup(`id=${trackId}`);
    if (!song) throw NOT_FOUND;
    return { tracks: [await matchNow(meta(song))] };
  }
  if (albumId) {
    const results = await lookup(`id=${albumId}&entity=song&limit=200`);
    const songs = results.filter((r: any) => r.wrapperType === 'track');
    if (!songs.length) throw new UserError('That Apple Music album could not be read.', 'Cet album Apple Music n’a pas pu être lu.');
    return { tracks: songs.map((r: any) => lazy(meta(r))), playlist: results[0]?.collectionName };
  }
  throw new UserError(
    'Apple Music playlists are not supported — paste a song or an album.',
    'Les playlists Apple Music ne sont pas prises en charge : colle un titre ou un album.'
  );
}

/** Tidal tracks: the page title names the song and the artist. */
async function tidal(url: string): Promise<{ tracks: Found[] }> {
  if (!/\/track\/\d+/.test(url)) {
    throw new UserError('Only Tidal tracks are supported — not albums or playlists.', 'Seuls les titres Tidal sont pris en charge, pas les albums ni les playlists.');
  }
  const html = await (await fetch(url, { headers: BROWSER, signal: AbortSignal.timeout(8000) })).text();
  const og = (p: string) => new RegExp(`<meta[^>]+property="og:${p}"[^>]+content="([^"]*)"`).exec(html)?.[1];
  const title = (og('title') ?? '').replace(/\s+on TIDAL$/i, '').trim();
  if (!title) throw NOT_FOUND;
  const found = await findOne(title.replace(/\s+by\s+/i, ' '));
  if (!found) throw NOT_FOUND;
  return { tracks: [{ ...found, thumbnail: og('image') ?? found.thumbnail, source: 'tidal', link: url }] };
}

/** Deezer albums and playlists: its public API lists the tracks; each is matched on YouTube when it plays. */
async function deezerCollection(kind: string, id: string): Promise<{ tracks: Found[]; playlist: string }> {
  const res = await fetch(`https://api.deezer.com/${kind}/${id}`, { signal: AbortSignal.timeout(8000) });
  const data: any = await res.json();
  if (!res.ok || data.error) throw new UserError('That Deezer link could not be read.', 'Ce lien Deezer n’a pas pu être lu.');
  const cover = data.cover_xl ?? data.picture_xl ?? null;
  const tracks: Found[] = (data.tracks?.data ?? []).map((t: any) => ({
    url: '',
    query: `${t.artist?.name ?? ''} ${t.title}`.trim(),
    title: t.title,
    author: t.artist?.name ?? '',
    duration: t.duration ?? null,
    thumbnail: t.album?.cover_xl ?? cover,
    source: 'deezer' as const,
    link: t.link ?? `https://www.deezer.com/track/${t.id}`,
  }));
  return { tracks, playlist: data.title };
}

/** Deezer share links (deezer.page.link) redirect to the real address. */
async function unshorten(url: string) {
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(6000) });
    return res.url || url;
  } catch {
    return url;
  }
}

// ---------- Entry point ----------

export async function resolveInput(input: string): Promise<{ tracks: Found[]; playlist?: string }> {
  const text = input.trim();

  const pick = /^ytm:([\w-]{11})$/.exec(text);
  if (pick) {
    const known = picked.get(pick[1]);
    if (known) return { tracks: [known.found] };
    return ytdlpResolve(`https://music.youtube.com/watch?v=${pick[1]}`);
  }

  if (!/^https?:\/\//i.test(text)) {
    const found = await findOne(text);
    if (!found) throw new UserError('Nothing found for that search.', 'Rien trouvé pour cette recherche.');
    return { tracks: [found] };
  }

  let url = text;
  let source = sourceOf(url);
  if (source === 'deezer' && /page\.link/.test(url)) {
    url = await unshorten(url);
    source = sourceOf(url);
  }

  if (source === 'deezer') {
    const m = /deezer\.com\/(?:[a-z]{2}\/)?(track|album|playlist)\/(\d+)/.exec(url);
    if (!m) throw new UserError('That Deezer link could not be read.', 'Ce lien Deezer n’a pas pu être lu.');
    if (m[1] !== 'track') return deezerCollection(m[1], m[2]);
    const t: any = await (await fetch(`https://api.deezer.com/track/${m[2]}`, { signal: AbortSignal.timeout(8000) })).json();
    if (t.error) throw NOT_FOUND;
    return {
      tracks: [
        await matchNow({
          title: t.title,
          author: t.artist?.name ?? '',
          duration: t.duration ?? null,
          thumbnail: t.album?.cover_xl ?? null,
          source: 'deezer',
          link: t.link ?? url,
        }),
      ],
    };
  }
  if (source === 'spotify') return spotify(url);
  if (source === 'apple') return apple(url);
  if (source === 'tidal') return tidal(url);

  try {
    const result = await ytdlpResolve(url);
    if (!result.tracks.length) throw new Error('empty');
    return result;
  } catch (err) {
    if (err instanceof UserError) throw err;
    throw new UserError('That link could not be played.', 'Ce lien ne peut pas être lu.');
  }
}

/** Fills in `url` for a track matched lazily (Deezer playlists). */
export async function ensurePlayable(track: Found): Promise<Found> {
  if (track.url) return track;
  const found = track.query ? await findOne(track.query) : null;
  if (!found) throw new UserError('No YouTube match for this track.', 'Aucune correspondance YouTube pour ce titre.');
  track.url = found.url;
  track.duration ??= found.duration;
  return track;
}
