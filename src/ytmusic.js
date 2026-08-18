/**
 * YouTube Music search over InnerTube (the API music.youtube.com itself calls).
 *
 * The bot used to search by spawning `yt-dlp ytsearchN:` — a whole process and
 * a full YouTube extraction, measured at ~3.4s per query. This is one HTTP POST
 * (~0.4s) against the *music* index, so results are songs rather than reaction
 * videos and 10-hour loops, and every hit already carries artist, album,
 * duration and real album artwork.
 *
 * yt-dlp stays as the fallback in resolve.js for when this endpoint changes.
 */

const ENDPOINT = 'https://music.youtube.com/youtubei/v1/search';
/** Search filter: "Songs" only. */
const SONGS_PARAMS = 'EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D';
const CLIENT_VERSION = '1.20240918.01.00';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// If InnerTube starts failing, stop paying its timeout on every search.
const FAILURE_THRESHOLD = 3;
const COOLDOWN_MS = 10 * 60 * 1000;
let consecutiveFailures = 0;
let disabledUntil = 0;

function textOf(runs) {
  return (runs || []).map((r) => r.text).join('');
}

/** Metadata rows read "Artist • Album • 3:58" — split on the bullet runs. */
function splitOnBullet(runs) {
  const parts = [];
  let cur = [];
  for (const run of runs || []) {
    if (run.text === ' • ') {
      parts.push(textOf(cur).trim());
      cur = [];
    } else {
      cur.push(run);
    }
  }
  parts.push(textOf(cur).trim());
  return parts.filter(Boolean);
}

function parseDuration(text) {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(String(text).trim());
  if (!m) return null;
  const [, h, mm, ss] = m;
  return Number(h || 0) * 3600 + Number(mm) * 60 + Number(ss);
}

function bestThumb(renderer) {
  const thumbs = renderer?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || [];
  if (!thumbs.length) return null;
  // Thumbnails come smallest-first; ask the CDN for a larger crop of the last.
  return String(thumbs[thumbs.length - 1].url).replace(/=w\d+-h\d+/, '=w544-h544');
}

function parseItem(node) {
  const r = node.musicResponsiveListItemRenderer;
  if (!r) return null;

  const id =
    r.playlistItemData?.videoId ||
    r.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer
      ?.playNavigationEndpoint?.watchEndpoint?.videoId;
  if (!/^[A-Za-z0-9_-]{11}$/.test(String(id || ''))) return null;

  const cols = r.flexColumns || [];
  const runsOf = (i) => cols[i]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];

  const title = textOf(runsOf(0)).trim();
  if (!title) return null;

  const parts = splitOnBullet(runsOf(1));
  const durIdx = parts.findIndex((p) => parseDuration(p) !== null);
  const duration = durIdx >= 0 ? parseDuration(parts[durIdx]) : null;

  // Song rows: Artist [• Album] • Duration. Video rows slip a view count in.
  const before = durIdx >= 0 ? parts.slice(0, durIdx) : parts;
  const meaningful = before.filter((p) => !/^[\d.,]+[KMB]?\s*(views?|plays?)$/i.test(p));
  const artist = meaningful[0] || '';
  const album = meaningful.length > 1 ? meaningful[meaningful.length - 1] : '';

  // Shape matches parsePrintLines() in resolve.js so both search tiers rank alike.
  return { id, title, channel: artist, artist, album, duration, artwork: bestThumb(r) };
}

function collectItems(json) {
  const tabs = json?.contents?.tabbedSearchResultsRenderer?.tabs || [];
  const sections = tabs[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];
  const out = [];
  for (const section of sections) {
    const nodes = section.musicShelfRenderer?.contents || section.musicCardShelfRenderer?.contents;
    for (const node of nodes || []) {
      const item = parseItem(node);
      if (item) out.push(item);
    }
  }
  return out;
}

function available() {
  return Date.now() >= disabledUntil;
}

async function ytmusicSearch(query, { limit = 8, timeoutMs = 4000 } = {}) {
  if (!available()) return [];

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
        Origin: 'https://music.youtube.com',
        Referer: 'https://music.youtube.com/',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      body: JSON.stringify({
        context: {
          client: { clientName: 'WEB_REMIX', clientVersion: CLIENT_VERSION, hl: 'en', gl: 'US' },
        },
        query: String(query || '').slice(0, 200),
        params: SONGS_PARAMS,
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const items = collectItems(await res.json());
    consecutiveFailures = 0;
    return items.slice(0, limit);
  } catch (err) {
    consecutiveFailures++;
    if (consecutiveFailures >= FAILURE_THRESHOLD) {
      disabledUntil = Date.now() + COOLDOWN_MS;
      consecutiveFailures = 0;
      console.warn('[music] YT Music search disabled for 10min, falling back to yt-dlp');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { ytmusicSearch, parseItem, collectItems, parseDuration, splitOnBullet };
