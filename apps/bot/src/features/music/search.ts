import dns from 'node:dns/promises';
import net from 'node:net';
import { log } from '../../core/log.js';
import { loadTracks, type LavalinkTrack } from './lavalink.js';
import { rememberDirect, runYtDlp } from './tools.js';

/** Tracks taken from one album or playlist, at most. */
export const MAX_TRACKS = 200;

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
  /** Lavalink's own track, when Lavalink read the link: playing it needs no second load. */
  encoded?: string;
}

/** An error whose message can be shown as is. */
export class UserError extends Error {}

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

// ---------- Reading a link ----------

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

const isYoutubeUrl = (url: string) => ['youtube', 'ytmusic'].includes(sourceOf(url));

/** « https://soundcloud.com/forss/city-ports » → « city ports »; « …/Song-1.mp3 » → « Song 1 ». */
function nameFromAddress(url: string) {
  try {
    const last = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() ?? '');
    return last.replace(/\.\w{2,5}$/, '').replace(/[-_]+/g, ' ').trim();
  } catch {
    return '';
  }
}

/**
 * A link read by yt-dlp. `list` says what to do with a playlist: take its tracks (their
 * titles only, which is quick), or leave it aside and read the one track the link names.
 *
 * A single track comes with its stream address in the same call, so that a YouTube
 * link is ready to play as soon as it is read, without a second lookup.
 */
async function ytdlpRead(url: string, list: boolean): Promise<{ tracks: Found[]; playlist?: string }> {
  const scope = list ? ['--flat-playlist', '--playlist-end', String(MAX_TRACKS)] : ['--no-playlist'];
  const info = JSON.parse(await runYtDlp(['-J', '-f', 'bestaudio/best', ...scope, url], list ? 40_000 : 25_000));
  if (!info) throw new Error('yt-dlp found nothing there');
  if (info._type === 'playlist' && Array.isArray(info.entries)) {
    const tracks = info.entries
      .filter((e: any) => e && (e.url || e.id))
      .map((e: any) => {
        const entryUrl = e.url?.startsWith('http') ? e.url : e.ie_key === 'Youtube' || /^[\w-]{11}$/.test(e.id) ? `https://www.youtube.com/watch?v=${e.id}` : e.url;
        const found = { ...fromInfo(e, entryUrl), url: entryUrl, link: entryUrl, source: sourceOf(entryUrl) };
        // Some sites list their tracks without naming them: the end of the address reads better than the whole of it.
        if (!e.track && !e.title) found.title = nameFromAddress(entryUrl) || found.title;
        return found;
      })
      // Entries are read from the page: only web addresses are kept.
      .filter((t: Found) => /^https?:\/\//i.test(t.url))
      .slice(0, MAX_TRACKS);
    return { tracks, playlist: info.title ?? undefined };
  }
  const found = fromInfo(info, url);
  const stream = info.url ?? info.requested_downloads?.[0]?.url;
  // YouTube's addresses say when they expire, so they can be kept until then.
  if (typeof stream === 'string' && /^https?:\/\//i.test(stream) && isYoutubeUrl(found.url)) rememberDirect(found.url, stream);
  return { tracks: [found] };
}

const NAMELESS = /^unknown (title|artist)$/i;

function fromLavalink(t: LavalinkTrack, fallbackUrl: string): Found {
  const url = t.info.uri && /^https?:\/\//i.test(t.info.uri) ? t.info.uri : fallbackUrl;
  return {
    url,
    // A plain media file carries no title: its file name stands in.
    title: !t.info.title || NAMELESS.test(t.info.title) ? nameFromAddress(url) || url : t.info.title,
    author: !t.info.author || NAMELESS.test(t.info.author) ? '' : t.info.author,
    duration: t.info.isStream || !t.info.length ? null : Math.round(t.info.length / 1000),
    thumbnail: t.info.artworkUrl ?? null,
    source: sourceOf(url),
    link: url,
    live: t.info.isStream,
    encoded: t.encoded,
  };
}

/**
 * The same link read by Lavalink, which knows SoundCloud, Bandcamp, Twitch, Vimeo and
 * plain media files by itself, and YouTube through its plugin. Null without a Lavalink
 * to ask.
 */
async function lavalinkRead(url: string): Promise<{ tracks: Found[]; playlist?: string } | null> {
  const r = await loadTracks(url, 12_000);
  if (!r) return null;
  if (r.loadType === 'track') return { tracks: [fromLavalink(r.data, url)] };
  if (r.loadType === 'playlist') {
    return { tracks: r.data.tracks.slice(0, MAX_TRACKS).map((t) => fromLavalink(t, url)), playlist: r.data.info?.name || undefined };
  }
  if (r.loadType === 'error') throw new Error(r.data?.message ?? 'Lavalink could not read it');
  throw new Error('Lavalink found nothing there');
}

/** Sites and files Lavalink reads by itself, quicker than yt-dlp does. */
function lavalinkReads(url: string) {
  const u = new URL(url);
  return (
    /(^|\.)(soundcloud\.com|bandcamp\.com|vimeo\.com|twitch\.tv)$/.test(u.hostname) ||
    /\.(mp3|m4a|aac|ogg|oga|opus|flac|wav|webm|mp4|m3u8?|pls)$/i.test(u.pathname)
  );
}

/**
 * Any other link: yt-dlp and Lavalink each get a try, the quicker one for that site
 * first, so that one of them failing is not the end of it.
 */
async function readLink(url: string): Promise<{ tracks: Found[]; playlist?: string }> {
  const errors: { ytdlp?: Error; lavalink?: Error } = {};
  const readers = {
    ytdlp: () => ytdlpRead(url, true),
    lavalink: () => lavalinkRead(url),
  };
  for (const name of lavalinkReads(url) ? (['lavalink', 'ytdlp'] as const) : (['ytdlp', 'lavalink'] as const)) {
    try {
      const result = await readers[name]();
      if (result?.tracks.length) return result;
    } catch (err) {
      errors[name] = err as Error;
    }
  }
  // yt-dlp says more about what went wrong.
  throw errors.ytdlp ?? errors.lavalink ?? new Error('nothing to play there');
}

// ---------- YouTube links ----------

/** The video and the playlist a YouTube address names, or null when the address is not YouTube's. */
export function youtubeRef(url: string): { video: string | null; list: string | null } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^(www|m|music)\./, '');
  let video: string | null;
  if (host === 'youtu.be') video = u.pathname.split('/')[1] ?? null;
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    video = /^\/(?:shorts|embed|live|v)\/([\w-]{11})/.exec(u.pathname)?.[1] ?? (u.pathname === '/watch' ? u.searchParams.get('v') : null);
  } else return null;
  const list = u.searchParams.get('list');
  return { video: video && /^[\w-]{11}$/.test(video) ? video : null, list: list && /^[\w-]{2,64}$/.test(list) ? list : null };
}

/**
 * Lists that come with a video without being a playlist to queue: the mixes and radios
 * YouTube builds around what is playing (hundreds of tracks, slow to read, and not
 * what someone sharing a song means), and the lists only their owner can open (liked
 * videos, watch later).
 */
const NOT_A_PLAYLIST = /^(RD|UL|LL$|WL$|LM$)/;

/** What a YouTube link asks for: a track, a playlist, or both (a playlist opened on one of its videos). */
export function youtubeWants(ref: { video: string | null; list: string | null }): 'track' | 'playlist' | 'both' | null {
  if (ref.video && (!ref.list || NOT_A_PLAYLIST.test(ref.list))) return 'track';
  if (ref.video && ref.list) return 'both';
  return ref.list ? 'playlist' : null;
}

/** YouTube's embed service names a video even when nothing else gets through. */
async function oembed(watch: string): Promise<Found | null> {
  const res = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(watch)}`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) return null;
  const j: any = await res.json();
  if (!j?.title) return null;
  return { url: watch, title: j.title, author: j.author_name ?? '', duration: null, thumbnail: j.thumbnail_url ?? null, source: sourceOf(watch), link: watch };
}

/** Answers after which asking another way is pointless: the video is gone, or closed to everyone. */
const GONE = /private video|video unavailable|video is unavailable|has been removed|does not exist|been terminated/i;

async function youtubeVideo(watch: string): Promise<Found> {
  let reason: Error;
  try {
    return (await ytdlpRead(watch, false)).tracks[0];
  } catch (err) {
    reason = err as Error;
  }
  if (GONE.test(reason.message)) throw reason;
  // YouTube may be refusing yt-dlp from this server just now. Lavalink's plugin asks it
  // another way; failing that, the video's name is enough to queue it, and every route
  // gets its chance when it plays.
  log.warn('music', `yt-dlp could not read ${watch} (${reason.message}): trying another way`);
  const other = (await lavalinkRead(watch).catch(() => null))?.tracks[0] ?? (await oembed(watch).catch(() => null));
  if (!other) throw reason;
  return other;
}

async function youtube(url: string, ref: { video: string | null; list: string | null }): Promise<{ tracks: Found[]; playlist?: string }> {
  const site = /(^|\.)music\.youtube\.com$/.test(new URL(url).hostname) ? 'music' : 'www';
  const watch = ref.video ? `https://${site}.youtube.com/watch?v=${ref.video}` : null;
  const wants = youtubeWants(ref);
  if (wants === 'playlist' || wants === 'both') {
    const listUrl = `https://www.youtube.com/playlist?list=${ref.list}`;
    try {
      const result = await readLink(listUrl);
      // Opened on one of its videos, the playlist starts there.
      const at = result.tracks.findIndex((t) => youtubeRef(t.url)?.video === ref.video);
      if (at > 0) result.tracks.push(...result.tracks.splice(0, at));
      return result;
    } catch (err) {
      // The playlist cannot be read (private, deleted): the video itself still can.
      if (!watch) throw err;
    }
  }
  if (!watch) return readLink(url); // a channel, a search page…
  return { tracks: [await youtubeVideo(watch)] };
}

async function youtubeSearch(query: string): Promise<Found | null> {
  const info = JSON.parse(await runYtDlp(['-J', '--flat-playlist', `ytsearch1:${query}`]));
  const e = info.entries?.[0];
  if (!e) return null;
  const url = `https://www.youtube.com/watch?v=${e.id}`;
  return { ...fromInfo(e, url), url, link: url, source: 'youtube' };
}

// ---------- Picking the best result ----------

const normalise = (t: string) =>
  t
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** Versions people rarely mean unless they ask for them. */
const VARIANTS = ['remix', 'live', 'cover', 'karaoke', 'instrumental', 'sped', 'slowed', 'reverb', 'nightcore', '8d', 'acoustic', 'mix', 'lofi'];
/** The song itself, cut for the radio or issued again: barely behind the original, and ahead of someone else's cover. */
const EDITIONS = ['edit', 'version', 'remaster', 'remastered'];
const IMITATORS = ['karaoke', 'tribute', 'cover', 'covers'];

/**
 * How well a result answers the search: the share of searched words found in its
 * title and artist, minus variants nobody asked for, with a small bonus for
 * YouTube Music's own ranking.
 */
export function matchScore(query: string, hit: Pick<Found, 'title' | 'author'>, rank: number) {
  const wanted = normalise(query).split(' ').filter(Boolean);
  const words = new Set(normalise(`${hit.title} ${hit.author}`).split(' '));
  const title = new Set(normalise(hit.title).split(' '));
  // The last word may still be being typed: the start of a word is enough for it.
  const found = (w: string, k: number) => words.has(w) || (k === wanted.length - 1 && [...words].some((x) => x.startsWith(w)));
  let score = wanted.length ? wanted.filter(found).length / wanted.length : 0;
  for (const v of VARIANTS) if (title.has(v) && !wanted.includes(v)) score -= 0.3;
  for (const v of EDITIONS) if (title.has(v) && !wanted.includes(v)) score -= 0.1;
  const artist = normalise(hit.author).split(' ');
  // Karaoke and tribute acts say so in their name rather than in the title.
  if (artist.some((w) => IMITATORS.includes(w) && !wanted.includes(w))) score -= 0.3;
  // An artist's name alone: their own songs come before the ones they only feature on.
  if (wanted.length && wanted.every((w, k) => artist.includes(w) || (k === wanted.length - 1 && artist.some((x) => x.startsWith(w))))) score += 0.2;
  return score - rank * 0.04;
}

/** Results in the order they answer the search, the closest first. */
const ranked = (query: string, hits: Found[]) =>
  hits
    .map((h, k) => ({ h, score: matchScore(query, h, k) }))
    .sort((a, b) => b.score - a.score)
    .map((x) => x.h);

// ---------- Suggestions while typing ----------
// /play suggests songs as the name is typed. What was suggested is remembered for a
// while: picking a suggestion plays it without searching again, and so does sending
// the same words without picking one.

const SUGGESTIONS = 10;
const SEARCH_TTL = 60_000;
const PICK_TTL = 10 * 60_000;
const searches = new Map<string, { hits: Found[]; at: number }>();
const picked = new Map<string, { found: Found; at: number }>();
const PICK = /^ytm:([\w-]{11})$/;
const videoOf = (found: Found) => new URL(found.url).searchParams.get('v');

/** What a suggestion sends back when it is picked. */
export const pickValue = (found: Found) => `ytm:${videoOf(found)}`;

/** Keeps a suggested song, so that picking it needs no lookup. */
export function rememberSuggestion(found: Found) {
  const id = videoOf(found);
  if (id) picked.set(id, { found, at: Date.now() });
}

/** Songs for what has been typed so far, the closest match first. */
export async function suggest(typed: string, timeoutMs = 2200): Promise<Found[]> {
  const key = normalise(typed);
  const now = Date.now();
  let entry = searches.get(key);
  if (!entry || now - entry.at > SEARCH_TTL) {
    // The same song often comes back twice (single and album): once is enough in a list.
    const seen = new Set<string>();
    const hits = ranked(typed, await searchMusic(typed, 15, timeoutMs)).filter((h) => {
      const line = `${normalise(h.title)}|${normalise(h.author)}|${h.duration}`;
      return !seen.has(line) && !!seen.add(line);
    });
    entry = { hits: hits.slice(0, SUGGESTIONS), at: now };
    for (const [k, v] of searches) if (now - v.at > SEARCH_TTL) searches.delete(k);
    for (const [k, v] of picked) if (now - v.at > PICK_TTL) picked.delete(k);
    searches.set(key, entry);
  }
  entry.hits.forEach(rememberSuggestion);
  return entry.hits;
}

/** Best match for free text: YouTube Music songs first, plain YouTube as a fallback. */
export async function findOne(query: string): Promise<Found | null> {
  try {
    // Sent as typed, without picking a suggestion: the first one is the best match.
    const hits = await suggest(query, 4000);
    if (hits.length) return { ...hits[0] };
  } catch {
    /* fall back below */
  }
  return youtubeSearch(query).catch(() => null);
}

// ---------- Links to private addresses ----------

/** Everything that is not the public internet: the host itself, local networks, and reserved ranges. */
const PRIVATE = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 3], // multicast, reserved and broadcast
] as const) {
  PRIVATE.addSubnet(address, prefix, 'ipv4');
}
for (const [address, prefix] of [
  ['::', 127], // unspecified and loopback
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  PRIVATE.addSubnet(address, prefix, 'ipv6');
}
/** NAT64: how hosts with IPv6 only reach IPv4 sites. The IPv4 address sits in the last 32 bits. */
const NAT64 = new net.BlockList();
NAT64.addSubnet('64:ff9b::', 96, 'ipv6');

/** The IPv4 address written in the last 32 bits of an IPv6 one (« 64:ff9b::7f00:1 » → « 127.0.0.1 »). */
function embeddedIPv4(ip: string) {
  const tail = ip.slice(ip.lastIndexOf(':') + 1);
  if (net.isIPv4(tail)) return tail;
  const groups = ip.split(':');
  const [hi, lo] = [parseInt(groups.at(-2) || '0', 16), parseInt(groups.at(-1) || '0', 16)];
  return [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.');
}

/** IPv4 addresses written as IPv6 (« ::ffff:127.0.0.1 », which URLs turn into « ::ffff:7f00:1 ») are read as IPv4. */
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) return PRIVATE.check(ip, 'ipv4');
  if (!net.isIPv6(ip)) return true; // not an address at all
  // Through NAT64, a public site is as public as its IPv4 address, and a private one as private.
  if (NAT64.check(ip, 'ipv6')) return isPrivateAddress(embeddedIPv4(ip));
  return PRIVATE.check(ip, 'ipv6');
}

/**
 * Links people paste are fetched by yt-dlp and Lavalink on the host: only public web
 * addresses are allowed, never the host itself or its local network.
 */
export async function assertPublicUrl(url: string) {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new UserError('That does not look like a link.');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new UserError('Only web links can be played.');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (!addresses.length) throw new UserError(`I could not find **${host}** — check the link.`);
  if (addresses.some(isPrivateAddress)) throw new UserError('That link points to a private address.');
}

// ---------- What was typed ----------

/**
 * The link in what was typed, or null when it is a search. People wrap links in < >
 * to keep Discord from previewing them, or leave a word next to them.
 */
export function linkIn(typed: string): string | null {
  const m = /https?:\/\/[^\s<>]+/i.exec(typed);
  return m ? m[0].replace(/[.,;!?]+$/, '') : null;
}

/** What to tell someone whose link could not be read, from what yt-dlp or Lavalink said about it. */
export function linkError(reason: string): UserError {
  const r = reason.toLowerCase();
  const tell = (message: string) => new UserError(message);
  if (/timed out|timeout|aborted/.test(r)) return tell('That link took too long to read — try again.');
  if (/not a bot|too many requests|http error 429/.test(r)) return tell('YouTube is turning this server away right now — try again in a moment, or type the name of the song.');
  if (/not currently live|is offline|not live/.test(r)) return tell('That channel is not live right now.');
  if (/private|sign in|log ?in|logged-in|members-only|confirm your age|age-restricted|inappropriate|cookies/.test(r)) {
    return tell('That link needs an account (private, age-restricted or members only): I cannot play it.');
  }
  if (/drm/.test(r)) return tell('That site protects its music: I cannot play it. Type the name of the song instead.');
  if (/unavailable|does not exist|not exist|removed|deleted|terminated|not available|not found|http error 40[34]/.test(r)) {
    return tell('Nothing plays at that link: the video or playlist is gone, or not available here.');
  }
  if (/unsupported url|not a valid url|no video|nothing to play|found nothing/.test(r)) return tell('I found nothing to play at that link.');
  return tell('That link could not be played.');
}

// ---------- Streaming services ----------
// Spotify, Apple Music and Tidal only give metadata; the audio comes from the best
// YouTube Music match. Tracks inside albums and playlists are matched when they play.

const BROWSER = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
};
const NOT_FOUND = new UserError('I could not find that track on YouTube.');

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
  if (!m) throw new UserError('That Spotify link could not be read.');
  const [, kind, id] = m;
  const html = await (await fetch(`https://open.spotify.com/embed/${kind}/${id}`, { headers: BROWSER, signal: AbortSignal.timeout(8000) })).text();
  const data = /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  const entity: any = data ? JSON.parse(data[1])?.props?.pageProps?.state?.data?.entity : null;
  if (!entity) throw new UserError('That Spotify link could not be read.');
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
  if (!tracks.length) throw new UserError('That Spotify playlist is empty or private.');
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
    if (!songs.length) throw new UserError('That Apple Music album could not be read.');
    return { tracks: songs.map((r: any) => lazy(meta(r))), playlist: results[0]?.collectionName };
  }
  throw new UserError('Apple Music playlists are not supported — paste a song or an album.');
}

/** Tidal tracks: the page title names the song and the artist. */
async function tidal(url: string): Promise<{ tracks: Found[] }> {
  if (!/\/track\/\d+/.test(url)) {
    throw new UserError('Only Tidal tracks are supported — not albums or playlists.');
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
  if (!res.ok || data.error) throw new UserError('That Deezer link could not be read.');
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

/** Share links (spotify.link, link.deezer.com, deezer.page.link) redirect to the real address. */
async function unshorten(url: string) {
  try {
    const res = await fetch(url, { redirect: 'follow', headers: BROWSER, signal: AbortSignal.timeout(6000) });
    return res.url || url;
  } catch {
    return url;
  }
}

const SPOTIFY_ITEM = /spotify\.com\/(?:intl-[a-z]+\/)?(track|album|playlist)\//;
const DEEZER_ITEM = /deezer\.com\/(?:[a-z]{2}\/)?(track|album|playlist)\/(\d+)/;

// ---------- Entry point ----------

/** What a link leads to, whichever site it is from. */
async function readAny(link: string): Promise<{ tracks: Found[]; playlist?: string }> {
  let url = link;
  let source = sourceOf(url);
  // A share link says nothing by itself: follow it to the track or the playlist it stands for.
  if ((source === 'deezer' && !DEEZER_ITEM.test(url)) || (source === 'spotify' && !SPOTIFY_ITEM.test(url))) {
    url = await unshorten(url);
    await assertPublicUrl(url); // where the short link led is checked like any other link
    source = sourceOf(url);
  }

  const ref = youtubeRef(url);
  if (ref) return youtube(url, ref);

  if (source === 'deezer') {
    const m = DEEZER_ITEM.exec(url);
    if (!m) throw new UserError('That Deezer link could not be read.');
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
  return readLink(url);
}

/** What /play was given, turned into tracks: a picked suggestion, a link, or words to search for. */
export async function resolveInput(input: string): Promise<{ tracks: Found[]; playlist?: string }> {
  const text = input.trim();

  const pick = PICK.exec(text);
  if (pick) {
    const known = picked.get(pick[1]);
    if (known) return { tracks: [{ ...known.found }] };
    // Suggested too long ago to be remembered: read again.
    return { tracks: [await youtubeVideo(`https://music.youtube.com/watch?v=${pick[1]}`)] };
  }

  const link = linkIn(text);
  if (!link) {
    const found = await findOne(text);
    if (!found) throw new UserError('Nothing found for that search.');
    return { tracks: [found] };
  }

  await assertPublicUrl(link);
  try {
    const result = await readAny(link);
    if (!result.tracks.length) throw new Error('nothing to play there');
    return result;
  } catch (err) {
    if (err instanceof UserError) throw err;
    // The reason goes to the console: the message shown only says what can be done about it.
    const reason = (err as Error).message;
    log.warn('music', `could not read ${link}: ${reason}`);
    throw linkError(reason);
  }
}

/** Fills in `url` for a track matched lazily (Deezer playlists). */
export async function ensurePlayable(track: Found): Promise<Found> {
  if (track.url) return track;
  const found = track.query ? await findOne(track.query) : null;
  if (!found) throw new UserError('No YouTube match for this track.');
  track.url = found.url;
  track.duration ??= found.duration;
  return track;
}
