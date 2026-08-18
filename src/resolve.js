const play = require('play-dl');
const {
  isYoutubeClipThumb,
  realMeta,
  getYtDlp,
  runYtDlp,
  extractVideoId,
  youtubeCompatArgs,
  searchCatalog,
  safeAlbumArt,
} = require('./player');
const { ytmusicSearch } = require('./ytmusic');


function detectUrlKind(input) {
  const raw = String(input || '').trim();
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { kind: 'text', raw };
  }

  const host = url.hostname.replace(/^www\./, '').toLowerCase();
  const href = url.href;

  if (host === 'music.youtube.com') {
    return { kind: 'youtubeMusic', raw: href, url };
  }
  if (host === 'youtube.com' || host === 'youtu.be' || host === 'm.youtube.com') {
    return { kind: 'youtube', raw: href, url };
  }
  if (host === 'open.spotify.com' || host === 'spotify.com') {
    return { kind: 'spotify', raw: href, url };
  }
  if (host === 'music.apple.com' || host === 'itunes.apple.com') {
    return { kind: 'appleMusic', raw: href, url };
  }
  if (host === 'deezer.com' || host.endsWith('.deezer.com')) {
    return { kind: 'deezer', raw: href, url };
  }
  if (
    host === 'tidal.com' ||
    host === 'listen.tidal.com' ||
    host === 'music.amazon.com' ||
    host === 'music.amazon.fr' ||
    host === 'amazon.com' ||
    host.endsWith('.amazon.com') ||
    host === 'pandora.com' ||
    host.endsWith('.pandora.com') ||
    host === 'napster.com' ||
    host.endsWith('.napster.com') ||
    host === 'song.link' ||
    host === 'album.link' ||
    host === 'odesli.co'
  ) {
    return { kind: 'songlink', raw: href, url };
  }

  return { kind: 'unknownUrl', raw: href, url };
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Ditto/1.0' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Ditto/1.0' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

function pickAlbumArt(...candidates) {
  for (const c of candidates) {
    if (c && !isYoutubeClipThumb(c)) return c;
  }
  return null;
}

async function itunesArtwork(term) {
  try {
    const data = await fetchJson(
      `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&media=music&entity=song&limit=1`
    );
    const hit = data?.results?.[0];
    const art = hit?.artworkUrl100?.replace('100x100bb', '600x600bb');
    return {
      artwork: pickAlbumArt(art),
      title: hit?.trackName || null,
      artist: hit?.artistName || null,
      album: hit?.collectionName || null,
    };
  } catch {
    return { artwork: null, title: null, artist: null, album: null };
  }
}

/**
 * Unified search metadata used by Spotify / Deezer / Apple / Songlink.
 */
function buildSearchMeta({
  platform,
  platformUrl,
  title,
  artist,
  album = '',
  artwork = null,
  youtubeUrl = null,
  durationSec = null,
}) {
  const cleanTitle = String(title || 'Unknown').trim();
  const cleanArtist = String(artist || 'Unknown').trim();
  const cleanAlbum = String(album || '').trim();
  return {
    platform,
    platformUrl,
    title: cleanTitle,
    artist: cleanArtist,
    album: cleanAlbum,
    artwork,
    youtubeUrl,
    durationSec: durationSec != null ? Number(durationSec) : null,
    searchQuery: `"${cleanTitle}" "${cleanArtist}"`,
    searchQueryAlt: `${cleanArtist} - ${cleanTitle}`,
    searchQueryTopic: `${cleanTitle} ${cleanArtist} Topic`,
    searchQueryOfficial: `${cleanTitle} ${cleanArtist} official audio`,
    matchQuery: `${cleanTitle} ${cleanArtist} ${cleanAlbum}`.trim(),
  };
}

/**
 * Enrich with song.link (odesli) — great title/artist across platforms.
 */
async function enrichWithSongLink(url, meta) {
  try {
    const data = await fetchJson(
      `https://api.song.link/v1-alpha.1/links?url=${encodeURIComponent(url)}&userCountry=FR`
    );
    const entity =
      (data.entityUniqueId && data.entitiesByUniqueId?.[data.entityUniqueId]) ||
      Object.values(data.entitiesByUniqueId || {})[0];

    const yt =
      data.linksByPlatform?.youtubeMusic?.url ||
      data.linksByPlatform?.youtube?.url ||
      null;

    if (!entity && !yt) return meta;

    const title = entity?.title || meta.title;
    const artist = entity?.artistName || meta.artist;
    const artwork = pickAlbumArt(entity?.thumbnailUrl, meta.artwork);

    console.log(`[music] song.link enrich → ${title} — ${artist}${yt ? ' (+YT link)' : ''}`);

    return buildSearchMeta({
      platform: meta.platform,
      platformUrl: meta.platformUrl || url,
      title,
      artist,
      album: meta.album || '',
      artwork,
      youtubeUrl: yt || meta.youtubeUrl || null,
      durationSec: meta.durationSec || null,
    });
  } catch (err) {
    console.warn('[music] song.link enrich failed:', err.message);
    return meta;
  }
}

/**
 * Enrich / confirm via iTunes Search (title + artist).
 */
async function enrichWithItunes(meta) {
  try {
    const hit = await itunesArtwork(`${meta.title} ${meta.artist}`);
    if (!hit?.title) return meta;
    return buildSearchMeta({
      platform: meta.platform,
      platformUrl: meta.platformUrl,
      title: meta.title || hit.title,
      artist: meta.artist || hit.artist || 'Unknown',
      album: meta.album || hit.album || '',
      artwork: pickAlbumArt(meta.artwork, hit.artwork),
      youtubeUrl: meta.youtubeUrl || null,
      durationSec: meta.durationSec || null,
    });
  } catch {
    return meta;
  }
}

async function finalizeMeta(url, meta) {
  // Parallel enrich — keeps resolve faster
  const [linked, itunes] = await Promise.all([
    (async () => {
      try {
        const data = await fetchJson(
          `https://api.song.link/v1-alpha.1/links?url=${encodeURIComponent(url)}&userCountry=FR`
        );
        const entity =
          (data.entityUniqueId && data.entitiesByUniqueId?.[data.entityUniqueId]) ||
          Object.values(data.entitiesByUniqueId || {})[0];
        const yt =
          data.linksByPlatform?.youtubeMusic?.url ||
          data.linksByPlatform?.youtube?.url ||
          null;
        if (!entity && !yt) return null;
        return {
          title: entity?.title || null,
          artist: entity?.artistName || null,
          artwork: entity?.thumbnailUrl || null,
          youtubeUrl: yt,
        };
      } catch {
        return null;
      }
    })(),
    itunesArtwork(`${meta.title} ${meta.artist}`),
  ]);

  const title = meta.title !== 'Unknown' ? meta.title : linked?.title || itunes.title || meta.title;
  const artist = meta.artist !== 'Unknown' ? meta.artist : linked?.artist || itunes.artist || meta.artist;
  const album = meta.album || itunes.album || '';
  const artwork = pickAlbumArt(meta.artwork, linked?.artwork, itunes.artwork);

  if (linked?.title) console.log(`[music] song.link enrich → ${linked.title} — ${linked.artist || '?'}`);

  return buildSearchMeta({
    platform: meta.platform,
    platformUrl: meta.platformUrl || url,
    title,
    artist,
    album,
    artwork,
    youtubeUrl: linked?.youtubeUrl || meta.youtubeUrl || null,
    durationSec: meta.durationSec || null,
  });
}

async function resolveSpotify(url) {
  const data = await fetchJson(`https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`);
  const titleRaw = (data.title || 'Unknown').trim();
  let title = titleRaw;
  let artist = (data.author_name || '').trim();

  if (!artist || /^spotify$/i.test(artist)) {
    const parts = titleRaw.split(/\s+[-–—]\s+/);
    if (parts.length >= 2) {
      title = parts.slice(0, -1).join(' - ').trim();
      artist = parts[parts.length - 1].trim();
    } else {
      artist = 'Unknown';
    }
  }

  // Spotify sometimes puts "Song · Artist" in title
  const dotParts = titleRaw.split(/\s+·\s+/);
  if (dotParts.length >= 2 && (artist === 'Unknown' || !artist)) {
    title = dotParts[0].trim();
    artist = dotParts.slice(1).join(' · ').trim();
  }

  let meta = buildSearchMeta({
    platform: 'Spotify',
    platformUrl: url,
    title,
    artist,
    artwork: pickAlbumArt(data.thumbnail_url),
  });
  // Skip heavy finalize when oEmbed already gave a real title/artist
  if (meta.title === 'Unknown' || meta.artist === 'Unknown') {
    meta = await finalizeMeta(url, meta);
  } else {
    // Light: prefer platform artwork only
    meta.artwork = pickAlbumArt(meta.artwork);
  }
  console.log(`[music] Spotify → ${meta.title} — ${meta.artist}`);
  return meta;
}

async function resolveDeezer(url) {
  // Support track + share links
  let trackId = url.match(/deezer\.com\/(?:[a-z]{2}\/)?track\/(\d+)/i)?.[1];
  if (!trackId) {
    // short link /share/ may redirect — try song.link path later via finalize
    trackId = url.match(/\/track\/(\d+)/i)?.[1];
  }
  if (!trackId) {
    // Fallback: song.link only
    let meta = buildSearchMeta({
      platform: 'Deezer',
      platformUrl: url,
      title: 'Unknown',
      artist: 'Unknown',
    });
    meta = await finalizeMeta(url, meta);
    if (meta.title === 'Unknown') throw new Error('Unsupported Deezer URL (need a track link).');
    console.log(`[music] Deezer → ${meta.title} — ${meta.artist}`);
    return meta;
  }

  const data = await fetchJson(`https://api.deezer.com/track/${trackId}`);
  if (data.error) throw new Error(data.error.message || 'Deezer track not found');

  let meta = buildSearchMeta({
    platform: 'Deezer',
    platformUrl: url,
    title: data.title,
    artist: data.artist?.name || 'Unknown',
    album: data.album?.title || '',
    artwork: pickAlbumArt(data.album?.cover_xl, data.album?.cover_big, data.album?.cover_medium),
    durationSec: data.duration || null,
  });
  // Deezer API already has full meta — skip song.link/iTunes
  console.log(`[music] Deezer → ${meta.title} — ${meta.artist}`);
  return meta;
}

async function itunesLookup(id) {
  const data = await fetchJson(`https://itunes.apple.com/lookup?id=${id}&entity=song`);
  return data.results || [];
}

async function itunesSearchSong(term) {
  const data = await fetchJson(
    `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&media=music&entity=song&limit=5`
  );
  return data.results || [];
}

function trackFromItunes(result) {
  return buildSearchMeta({
    platform: 'Apple Music',
    title: result.trackName || result.collectionCensoredName || 'Unknown',
    artist: result.artistName || 'Unknown',
    album: result.collectionName || '',
    artwork: pickAlbumArt(
      result.artworkUrl100?.replace('100x100bb', '600x600bb'),
      result.artworkUrl100
    ),
    durationSec: result.trackTimeMillis ? Math.round(result.trackTimeMillis / 1000) : null,
  });
}

function parseAppleMusicIds(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return {};
  }
  const trackFromQuery = u.searchParams.get('i');
  const parts = u.pathname.split('/').filter(Boolean);
  // /us/song/blinding-lights/1499378607
  // /us/album/after-hours/1499378108
  let kind = null;
  let slug = null;
  let pathId = null;
  const songIdx = parts.indexOf('song');
  const albumIdx = parts.indexOf('album');
  if (songIdx >= 0) {
    kind = 'song';
    slug = parts[songIdx + 1] || null;
    pathId = parts[songIdx + 2] || null;
  } else if (albumIdx >= 0) {
    kind = 'album';
    slug = parts[albumIdx + 1] || null;
    pathId = parts[albumIdx + 2] || null;
  }
  return {
    trackId: trackFromQuery || (kind === 'song' ? pathId : null),
    albumId: kind === 'album' ? pathId : null,
    slug: slug ? decodeURIComponent(slug).replace(/-/g, ' ') : null,
  };
}

async function resolveAppleMusic(url) {
  const ids = parseAppleMusicIds(url);
  let itunesTrack = null;

  // 1) Direct track id (?i= or /song/.../id)
  if (ids.trackId) {
    const results = await itunesLookup(ids.trackId);
    itunesTrack = results.find((r) => r.wrapperType === 'track' && String(r.trackId) === String(ids.trackId));
    if (!itunesTrack) {
      itunesTrack = results.find((r) => r.wrapperType === 'track');
    }
  }

  // 2) Album page: lookup album songs and pick ?i= track
  if (!itunesTrack && ids.albumId) {
    const results = await itunesLookup(ids.albumId);
    const songs = results.filter((r) => r.wrapperType === 'track');
    if (ids.trackId) {
      itunesTrack = songs.find((s) => String(s.trackId) === String(ids.trackId));
    }
    // If no i= on album URL, we cannot know which song — use slug search
  }

  // 3) Fallback: iTunes text search from URL slug
  if (!itunesTrack && ids.slug) {
    const results = await itunesSearchSong(ids.slug);
    itunesTrack = results.find((r) => r.wrapperType === 'track') || results[0];
  }

  // 4) Last resort: scrape (often blocked by Apple web player shell)
  if (!itunesTrack) {
    const html = await fetchText(url);
    const ogTitle =
      html.match(/property="og:title"\s+content="([^"]+)"/i)?.[1] ||
      html.match(/content="([^"]+)"\s+property="og:title"/i)?.[1];
    const ogImage =
      html.match(/property="og:image"\s+content="([^"]+)"/i)?.[1] ||
      html.match(/content="([^"]+)"\s+property="og:image"/i)?.[1];
    const ogDesc =
      html.match(/property="og:description"\s+content="([^"]+)"/i)?.[1] ||
      html.match(/content="([^"]+)"\s+property="og:description"/i)?.[1];

    if (ogTitle && !/apple\s*music web player/i.test(ogTitle)) {
      let title = ogTitle.replace(/&amp;/g, '&').replace(/&#039;/g, "'");
      let artist = 'Unknown';
      const byMatch = title.match(/^(.*?)\s+by\s+(.+)$/i);
      if (byMatch) {
        title = byMatch[1].trim();
        artist = byMatch[2].trim();
      } else if (ogDesc) {
        const descBy = ogDesc.replace(/&amp;/g, '&').match(/by\s+([^·\n]+)/i);
        if (descBy) artist = descBy[1].trim();
      }
      // Enrich via iTunes search with title + artist
      const found = await itunesSearchSong(`${title} ${artist}`);
      const hit = found.find((r) => r.wrapperType === 'track');
      if (hit) {
        let meta = trackFromItunes(hit);
        meta.platformUrl = url;
        return finalizeMeta(url, meta);
      }
      let meta = buildSearchMeta({
        platform: 'Apple Music',
        platformUrl: url,
        title,
        artist,
        artwork: pickAlbumArt(ogImage),
      });
      return finalizeMeta(url, meta);
    }
  }

  if (!itunesTrack) {
    // Last chance: song.link only
    let meta = buildSearchMeta({
      platform: 'Apple Music',
      platformUrl: url,
      title: ids.slug || 'Unknown',
      artist: 'Unknown',
    });
    meta = await finalizeMeta(url, meta);
    if (!meta.artist || meta.artist === 'Unknown' || meta.title === 'Unknown') {
      throw new Error(
        'Could not read Apple Music track metadata. Use a song link (…/song/…/id) or album link with ?i=trackId.'
      );
    }
    console.log(`[music] Apple Music → ${meta.title} — ${meta.artist}`);
    return meta;
  }

  let meta = trackFromItunes(itunesTrack);
  meta.platformUrl = url;
  // iTunes lookup already has title/artist/album/art — skip song.link
  console.log(`[music] Apple Music → ${meta.title} — ${meta.artist}`);
  return meta;
}

function normalizeText(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripNoise(title) {
  return normalizeText(title)
    .replace(/\b(official audio|official video|official music video|lyrics|lyric video|audio|video|hd|4k|remaster(ed)?|visualizer|topic|instrumental|live)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Character-level similarity 0..1 (Levenshtein). */
function charSimilarity(a, b) {
  const s = normalizeText(a);
  const t = normalizeText(b);
  if (!s && !t) return 1;
  if (!s || !t) return 0;
  if (s === t) return 1;
  const n = s.length;
  const m = t.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 0; i <= n; i++) dp[i][0] = i;
  for (let j = 0; j <= m; j++) dp[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return 1 - dp[n][m] / Math.max(n, m);
}

function isYoutubeVideoId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{11}$/.test(id);
}

function parsePrintLines(stdout) {
  return stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [id, title, channel, duration, album, artist] = line.split('|||');
      const vid = id && id !== 'NA' ? id.split('&')[0] : '';
      if (!isYoutubeVideoId(vid)) return null;
      const dur = duration && duration !== 'NA' ? Number(duration) : null;
      return {
        id: vid,
        title: title && title !== 'NA' ? title : '',
        channel: channel && channel !== 'NA' ? channel : '',
        artist: artist && artist !== 'NA' ? artist : '',
        album: album && album !== 'NA' ? album : '',
        duration: Number.isFinite(dur) ? dur : null,
      };
    })
    .filter(Boolean);
}

/**
 * Precise score: title char-exact, artist, album, duration.
 */
function scorePrecise(preferred, entry) {
  const wantTitle = preferred.title || '';
  const wantArtist = preferred.artist || '';
  const wantAlbum = preferred.album || '';

  const title = entry.title || '';
  const channel = entry.channel || '';
  const entryArtist = entry.artist || '';
  const entryAlbum = entry.album || '';
  const hayArtist = `${channel} ${entryArtist}`.trim();

  let score = 0;

  // Title — character precision
  const cleanGot = stripNoise(title);
  const cleanWant = normalizeText(wantTitle);
  if (cleanGot === cleanWant) score += 100;
  else {
    const sim = Math.max(charSimilarity(cleanWant, cleanGot), charSimilarity(wantTitle, title));
    score += sim * 90;
    if (sim < 0.82) score -= 40; // reject loose title matches
  }

  // Artist — must align
  if (wantArtist && normalizeText(wantArtist) !== 'unknown') {
    const wa = normalizeText(wantArtist);
    const ha = normalizeText(hayArtist);
    const ta = normalizeText(title);
    if (ha === wa || ha === `${wa} topic`) score += 80;
    else if (ha.includes(wa) || ta.includes(wa)) score += 55;
    else {
      // Catalogues disagree about featured artists: iTunes says "Daft Punk &
      // Julian Casablancas" where YouTube Music says "Daft Punk". A plain
      // includes() in one direction called those different artists and docked
      // 70 points off the correct track. Compare the token sets both ways.
      const waTokens = new Set(wa.split(' ').filter((t) => t.length > 1));
      const haTokens = new Set(`${ha} ${ta}`.split(' ').filter((t) => t.length > 1));
      let shared = 0;
      for (const token of waTokens) if (haTokens.has(token)) shared++;
      const overlap = waTokens.size ? shared / Math.min(waTokens.size, haTokens.size || 1) : 0;
      const simA = Math.max(charSimilarity(wa, ha), charSimilarity(wa, ta));
      if (overlap >= 0.6 || simA >= 0.9) score += 45;
      else if (overlap >= 0.34 || simA >= 0.75) score += 15;
      else score -= 70; // genuinely a different artist
    }
    if (/\btopic\b/.test(ha)) score += 15;
  }

  // Album — compare when we have it from the URL metadata
  if (wantAlbum) {
    const wal = normalizeText(wantAlbum);
    const eal = normalizeText(entryAlbum);
    const inTitle = normalizeText(title).includes(wal);
    if (eal && (eal === wal || charSimilarity(wal, eal) >= 0.9)) score += 50;
    else if (inTitle) score += 20;
    else if (eal && charSimilarity(wal, eal) >= 0.75) score += 10;
    else if (eal) score -= 15; // album present but different
  }

  // Duration
  if (preferred.durationSec && entry.duration) {
    const diff = Math.abs(Number(preferred.durationSec) - Number(entry.duration));
    if (diff <= 2) score += 25;
    else if (diff <= 6) score += 15;
    else if (diff <= 12) score += 5;
    else if (diff > 40) score -= 30;
  }

  // Junk
  const junk = /\b(cover|karaoke|nightcore|sped up|slowed|slowed\s*\+?\s*reverb|8d|live|remix|mashup|reaction|instrumental|piano|violin|gaming|lyrics?\s*video|hour\s*version)\b/i;
  if (junk.test(title) && !junk.test(wantTitle)) score -= 70;

  if (/\bofficial audio\b/i.test(title)) score += 25;
  if (/\btopic\b/i.test(hayArtist)) score += 30;
  if (/\bvevo\b/i.test(hayArtist)) score += 18;
  if (/\bofficial (music )?video\b/i.test(title)) score += 8;
  if (/\blyrics?\b/i.test(title) && !/\bofficial audio\b/i.test(title)) score -= 15;

  return score;
}

function toTrackFromEntry(entry, sourceKind = 'youtubeMusic') {
  const id = String(entry.id || '')
    .replace(/^https?:\/\/(www\.)?youtube\.com\/watch\?v=/i, '')
    .replace(/^https?:\/\/youtu\.be\//i, '')
    .split('&')[0];
  if (!isYoutubeVideoId(id)) return null;
  return {
    title: entry.title || '',
    artist: entry.channel || entry.artist || '',
    durationSec: entry.duration || null,
    album: entry.album || '',
    url: `https://music.youtube.com/watch?v=${id}`,
    watchUrl: `https://www.youtube.com/watch?v=${id}`,
    sourceKind,
    // YouTube Music hands back real album art — keep it instead of dropping it.
    artwork: safeAlbumArt(entry.artwork) || null,
  };
}

/**
 * Resolve known metadata (from a Spotify/Apple/Deezer link, or a playlist row)
 * to a playable YouTube track.
 */
async function searchYoutubeMusic(query, preferred = null, opts = {}) {
  const fast = Boolean(opts.fast);
  const meta = preferred || { title: query, artist: '', album: '' };
  const primary =
    meta.title && meta.artist && meta.artist !== 'Unknown'
      ? `${meta.artist} - ${meta.title}`
      : meta.searchQueryAlt || query;

  // NOTE: this used to pre-filter to entries whose title matched exactly and
  // rank only those. That is a hard filter, so a soundalike upload with the
  // exact title ("Instant Crush" by an unrelated artist) discarded the real
  // track before it was ever scored. scorePrecise already rewards an exact
  // title with +100, so rank everything and let artist/album/duration decide.
  const rankAgainst = (entries) =>
    entries
      .map((e) => ({ e, score: scorePrecise(meta, e) }))
      .sort((a, b) => b.score - a.score);

  let printed = await ytsearchFlat(primary, opts.n || 3);
  if (!printed.length && query && query !== primary) {
    printed = await ytsearchFlat(query, 3);
  }

  let ranked = rankAgainst(printed);

  // YouTube Music does not index every upload — bootlegs, live sets and a lot
  // of French rap only exist on YouTube proper. Escalate to the broad search
  // before giving up, which is what the old single-tier search always did.
  if (!ranked.length || ranked[0].score < WEAK_MATCH_SCORE) {
    const broad = await ytsearchYtDlp(primary, 3).catch(() => []);
    if (broad.length) {
      const seen = new Set(printed.map((e) => e.id));
      printed = printed.concat(broad.filter((e) => !seen.has(e.id)));
      ranked = rankAgainst(printed);
    }
  }

  if (!ranked.length) {
    throw new Error(`No playable YouTube results for: ${primary}`);
  }

  console.log(
    `[music] ranked:`,
    ranked
      .slice(0, 3)
      .map((x) => `${x.score.toFixed(0)}:"${x.e.title}"`)
      .join(' | ')
  );

  if (fast && ranked[0].score < WEAK_MATCH_SCORE) {
    throw new Error(`Weak YouTube match for: ${meta.title || primary}`);
  }

  const best = toTrackFromEntry(ranked[0].e);
  if (!best) throw new Error(`No playable YouTube results for: ${primary}`);
  if (meta.title) best.title = meta.title;
  if (meta.artist) best.artist = meta.artist;
  if (meta.album) best.album = meta.album;
  if (meta.durationSec && !best.durationSec) best.durationSec = meta.durationSec;
  return best;
}

const YT_SEARCH_CACHE_TTL = 15 * 60 * 1000;
const ytSearchCache = new Map();
/** Below this, scorePrecise() is telling us this is not the right track. */
const WEAK_MATCH_SCORE = 55;
/** Above this, scoreFreeText() matched the query well enough to skip the catalog. */
const FREE_TEXT_CONFIDENT = 95;

function searchCacheGet(key) {
  const hit = ytSearchCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.entries;
  return null;
}

function searchCacheSet(key, entries) {
  if (entries.length) {
    ytSearchCache.set(key, { entries, expires: Date.now() + YT_SEARCH_CACHE_TTL });
  }
  return entries;
}

/**
 * Broad search across all of YouTube. Costs a yt-dlp subprocess and a full
 * extraction (~3.4s measured), but it sees uploads YouTube Music never indexes.
 */
async function ytsearchYtDlp(query, n = 3) {
  const key = `ytdlp:${n}:${String(query || '').trim().toLowerCase()}`;
  const cached = searchCacheGet(key);
  if (cached) return cached;

  console.log(`[music] broad YouTube search: ${query}`);
  const bin = await getYtDlp();
  const t0 = Date.now();
  try {
    const { stdout } = await runYtDlp(
      bin,
      [
        `ytsearch${n}:${query}`,
        '--print',
        '%(id)s|||%(title)s|||%(channel)s|||%(duration)s|||%(album)s|||%(artist)s',
        '--skip-download',
        '--no-warnings',
        '--no-playlist',
        '--ignore-errors',
        '--socket-timeout',
        '15',
        ...youtubeCompatArgs(),
      ],
      { allowNonZero: true, timeoutMs: 22_000 }
    );
    const entries = parsePrintLines(stdout);
    console.log(`[music] ytsearch ${entries.length} hits in ${Date.now() - t0}ms`);
    return searchCacheSet(key, entries);
  } catch (err) {
    console.warn('[music] ytsearch failed:', err.message);
    return [];
  }
}

/**
 * Default search: the YouTube Music songs index over InnerTube — one HTTP call
 * (~0.4s) against a music-only catalogue, with artist, album, duration and real
 * album art on every hit. Falls back to the broad search when unavailable.
 *
 * Both tiers return the same entry shape, so ranking does not care which ran.
 */
async function ytsearchFlat(query, n = 3) {
  const key = `ytm:${n}:${String(query || '').trim().toLowerCase()}`;
  const cached = searchCacheGet(key);
  if (cached) {
    console.log(`[music] search cache: ${query}`);
    return cached;
  }

  const t0 = Date.now();
  try {
    const entries = await ytmusicSearch(query, { limit: Math.max(n, 5) });
    if (entries.length) {
      console.log(`[music] YT Music ${entries.length} hits in ${Date.now() - t0}ms: ${query}`);
      return searchCacheSet(key, entries);
    }
  } catch (err) {
    console.warn('[music] YT Music search failed:', String(err.message || err).slice(0, 120));
  }

  return ytsearchYtDlp(query, n);
}

/**
 * Ranking for a raw user query like "daft punk instant crush", where there is
 * no trusted catalog entry to compare field by field.
 *
 * scorePrecise() assumes the entry title carries "Artist - Title" — true of
 * yt-dlp results, false of YouTube Music, whose titles are just the song. Token
 * coverage across title + artist + album works for both.
 */
function scoreFreeText(query, entry, rank = 0) {
  const tokens = normalizeText(query).split(' ').filter(Boolean);
  if (!tokens.length) return 0;

  const title = normalizeText(entry.title || '');
  const artist = normalizeText(`${entry.channel || ''} ${entry.artist || ''}`);
  const album = normalizeText(entry.album || '');
  const hay = `${title} ${artist} ${album}`;

  let covered = 0;
  let inTitle = 0;
  for (const token of tokens) {
    if (hay.includes(token)) covered++;
    if (title.includes(token)) inTitle++;
  }

  let score = (covered / tokens.length) * 100;
  if (covered === tokens.length) score += 25;
  score += (inTitle / tokens.length) * 15;

  // "Song" beats "Song (Sped Up Remix) (feat. ...)" when both cover the query.
  const extraWords = Math.max(0, title.split(' ').filter(Boolean).length - inTitle);
  score -= Math.min(20, extraWords * 4);

  const junk =
    /\b(cover|karaoke|nightcore|sped up|slowed|reverb|8d|live|remix|mashup|reaction|instrumental|tribute|hour\s*version)\b/i;
  if (junk.test(entry.title || '') && !junk.test(query)) score -= 60;

  // The music index already ordered these by relevance — honour it on ties.
  return score - rank * 2;
}

/** Does the catalog's artist actually appear in what the user typed? */
function catalogArtistInQuery(query, catalog) {
  const q = normalizeText(query);
  const tokens = normalizeText(catalog.artist || '')
    .split(' ')
    .filter((t) => t.length > 1);
  return tokens.length > 0 && tokens.some((t) => q.includes(t));
}

/**
 * Free-text search.
 *
 * The catalog lookup (Deezer/iTunes) and the music search run in PARALLEL now
 * rather than one feeding the other, which removes a whole search round-trip
 * from every /play. The two then cross-check each other, because neither is
 * reliable alone: the catalog rescues typo'd queries the music index misses,
 * and the music index rejects the wrong-artist uploads the catalog sometimes
 * matches.
 */
async function resolveTextSearch(query) {
  const t0 = Date.now();

  const [catalog, initial] = await Promise.all([
    searchCatalog(query).catch(() => null),
    ytsearchFlat(query, 3),
  ]);

  let trustCatalog = Boolean(catalog);
  let preferred = { title: query, artist: '', album: '', durationSec: null };

  if (catalog) {
    preferred = buildSearchMeta({
      platform: 'YouTube Music',
      title: catalog.title,
      artist: catalog.artist,
      album: catalog.album || '',
      artwork: catalog.artwork,
      durationSec: catalog.durationSec,
    });
  }

  const rankEntries = (entries) => {
    if (!entries.length) return [];
    if (!trustCatalog) {
      return entries
        .map((e, i) => ({ e, score: scoreFreeText(query, e, i) }))
        .sort((a, b) => b.score - a.score);
    }
    return entries
      .map((e) => ({ e, score: scorePrecise(preferred, e) }))
      .sort((a, b) => b.score - a.score);
  };

  let flat = initial;
  let ranked = rankEntries(flat);

  const merge = (extra) => {
    if (!extra.length) return;
    const seen = new Set(flat.map((e) => e.id));
    flat = flat.concat(extra.filter((e) => !seen.has(e.id)));
    ranked = rankEntries(flat);
  };

  if (catalog && (!ranked.length || ranked[0].score < WEAK_MATCH_SCORE)) {
    // Nothing here matches what the catalog described. Either the user typed a
    // typo and the catalog is right, or the catalog matched the wrong upload.
    const freeBest = flat.length
      ? Math.max(...flat.map((e, i) => scoreFreeText(query, e, i)))
      : 0;
    if (freeBest >= FREE_TEXT_CONFIDENT || !catalogArtistInQuery(query, catalog)) {
      // Either the music index found something that plainly matches what was
      // typed, or the catalog's artist appears nowhere in the query. Trust the
      // query — and skip the 5s broad search entirely.
      console.log(`[music] ignoring catalog hit "${catalog.artist}" (free-text ${freeBest.toFixed(0)})`);
      trustCatalog = false;
      ranked = rankEntries(flat);
    } else {
      merge(await ytsearchYtDlp(`${catalog.artist} - ${catalog.title}`, 3).catch(() => []));
    }
  } else if (!catalog && (!ranked.length || ranked[0].score < 40)) {
    merge(await ytsearchYtDlp(`${query} official audio`, 3).catch(() => []));
  }

  if (!ranked.length) {
    throw new Error(`No playable YouTube results for: ${query}`);
  }

  console.log(
    `[music] text search ${Date.now() - t0}ms:`,
    ranked
      .slice(0, 3)
      .map((x) => `${x.score.toFixed(0)}:"${x.e.title}"`)
      .join(' | ')
  );

  const best = toTrackFromEntry(ranked[0].e);
  if (!best) throw new Error(`No playable YouTube results for: ${query}`);

  if (trustCatalog && catalog) {
    best.title = catalog.title;
    best.artist = catalog.artist;
    best.album = catalog.album || best.album;
    best.durationSec = catalog.durationSec || best.durationSec;
    best.artwork = pickAlbumArt(catalog.artwork, best.artwork);
    best.genre = catalog.genre;
  }
  best.origin = {
    platform: 'YouTube Music',
    platformUrl: best.url,
    fromSearch: true,
    catalog: trustCatalog && catalog ? catalog.source : null,
  };

  return best;
}

function trackFromYoutubeUrl(url, sourceKind) {
  const id = extractVideoId(url);
  if (!id || !isYoutubeVideoId(id)) {
    throw new Error('Invalid YouTube URL (missing video id).');
  }
  return {
    title: '',
    artist: '',
    durationSec: null,
    album: '',
    url:
      sourceKind === 'youtubeMusic'
        ? `https://music.youtube.com/watch?v=${id}`
        : `https://www.youtube.com/watch?v=${id}`,
    watchUrl: `https://www.youtube.com/watch?v=${id}`,
    sourceKind,
    artwork: null,
    fromStub: true,
  };
}

function trackFromYoutubeId(id, sourceKind, overrides = {}) {
  return {
    title: realMeta(overrides.title),
    artist: realMeta(overrides.artist),
    durationSec: overrides.durationSec || null,
    album: overrides.album || '',
    url:
      sourceKind === 'youtubeMusic'
        ? `https://music.youtube.com/watch?v=${id}`
        : `https://www.youtube.com/watch?v=${id}`,
    watchUrl: `https://www.youtube.com/watch?v=${id}`,
    sourceKind,
    artwork: safeAlbumArt(overrides.artwork) || null,
    fromStub: !realMeta(overrides.title),
  };
}

/**
 * Fill title/channel from YouTube oEmbed when catalog metadata is missing.
 * Never invents "Unknown".
 */
async function hydrateYoutubeMeta(track, timeoutMs = 800) {
  if (!track) return track;
  const hasTitle = Boolean(realMeta(track.title));
  const hasArtist = Boolean(realMeta(track.artist));
  if (hasTitle && hasArtist) return track;

  const url = track.watchUrl || track.url;
  if (!url || !/youtu(\.be|be\.com)/i.test(url)) return track;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`,
      {
        signal: ctrl.signal,
        headers: { 'User-Agent': 'Ditto/1.0' },
      }
    );
    if (!res.ok) return track;
    const oe = await res.json();
    if (!hasTitle && oe?.title) track.title = String(oe.title).trim();
    if (!hasArtist && oe?.author_name) track.artist = String(oe.author_name).trim();
    if (realMeta(track.title)) track.fromStub = false;
  } catch (_) {
    /* keep whatever we already have */
  } finally {
    clearTimeout(timer);
  }
  return track;
}

async function getYoutubeInfo(url, sourceKind) {
  // Prefer yt-dlp metadata — play-dl/ytdl-core often fail on current YouTube
  try {
    const bin = await getYtDlp();
    const { stdout } = await runYtDlp(bin, [
      '--print',
      '%(id)s|||%(title)s|||%(uploader|channel|artist)s|||%(duration)s',
      '--no-playlist',
      '--no-warnings',
      '--skip-download',
      ...youtubeCompatArgs(),
      url,
    ], { timeoutMs: 25_000 });
    const line = stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.includes('|||'));
    if (line) {
      const [id, title, channel, duration] = line.split('|||');
      const dur = duration && duration !== 'NA' ? Number(duration) : null;
      return {
        title: title && title !== 'NA' ? title : '',
        artist: channel && channel !== 'NA' ? channel : '',
        durationSec: Number.isFinite(dur) ? dur : null,
        url:
          sourceKind === 'youtubeMusic'
            ? `https://music.youtube.com/watch?v=${id}`
            : `https://www.youtube.com/watch?v=${id}`,
        watchUrl: `https://www.youtube.com/watch?v=${id}`,
        sourceKind,
        artwork: null,
      };
    }
  } catch (err) {
    console.warn('[music] yt-dlp metadata failed, play-dl fallback:', err.message);
  }

  const info = await play.video_info(url);
  const details = info.video_details;
  const id = details.id;
  return {
    title: details.title || '',
    artist: details.channel?.name || details.artist || '',
    durationSec: details.durationInSec || null,
    url:
      sourceKind === 'youtubeMusic'
        ? `https://music.youtube.com/watch?v=${id}`
        : `https://www.youtube.com/watch?v=${id}`,
    watchUrl: `https://www.youtube.com/watch?v=${id}`,
    sourceKind,
    artwork: null,
  };
}

/**
 * Resolve /play input: single track or playlist.
 * @param {string} input
 * @param {{ mode?: 'track'|'playlist' }} [opts]
 * @returns {{ type: 'track', track } | { type: 'playlist', ... }}
 */
async function resolvePlayInput(input, opts = {}) {
  const parsed = parseSearchMode(input);
  const mode = opts.mode === 'playlist' || parsed.mode === 'playlist' ? 'playlist' : 'track';
  const query = parsed.query;

  const detected = detectUrlKind(query);

  // URL playlist / album
  if (detectPlaylistKind(detected)) {
    const playlist = await loadPlaylist(detected);
    if (playlist?.entries?.length) return playlist;
  }

  // Text for a YouTube playlist
  if (mode === 'playlist') {
    if (detected.kind !== 'text') {
      throw new Error('Playlist search needs text (or a playlist URL). Example: playlist: daft punk discovery');
    }
    return searchAndLoadYoutubePlaylist(query);
  }

  const track = await resolvePlayQuery(query);
  return { type: 'track', track };
}

/**
 * Resolve any /play input into a playable track object (single).
 */
async function resolvePlayQuery(input) {
  const detected = detectUrlKind(input);

  // YouTube links: stub instantly — title/artwork are filled in by the player
  if (detected.kind === 'youtubeMusic' || detected.kind === 'youtube') {
    const kind = detected.kind === 'youtubeMusic' ? 'youtubeMusic' : 'youtube';
    const track = trackFromYoutubeUrl(detected.raw, kind);
    track.origin = {
      platform: kind === 'youtubeMusic' ? 'YouTube Music' : 'YouTube',
      platformUrl: detected.raw,
    };
    return track;
  }

  let meta = null;
  if (detected.kind === 'spotify') meta = await resolveSpotify(detected.raw);
  else if (detected.kind === 'deezer') meta = await resolveDeezer(detected.raw);
  else if (detected.kind === 'appleMusic') meta = await resolveAppleMusic(detected.raw);
  else if (detected.kind === 'songlink') {
    meta = buildSearchMeta({
      platform: 'Music link',
      platformUrl: detected.raw,
      title: 'Unknown',
      artist: 'Unknown',
    });
    meta = await finalizeMeta(detected.raw, meta);
    if (meta.title === 'Unknown') {
      throw new Error('Could not resolve that music link (Spotify / Apple / Deezer / Tidal / Amazon / …).');
    }
    console.log(`[music] Music link → ${meta.title} — ${meta.artist}`);
  } else if (detected.kind === 'unknownUrl') {
    meta = buildSearchMeta({
      platform: 'Music link',
      platformUrl: detected.raw,
      title: 'Unknown',
      artist: 'Unknown',
    });
    meta = await finalizeMeta(detected.raw, meta);
    if (meta.title === 'Unknown') {
      throw new Error('Unsupported link. Use YouTube, YouTube Music, Spotify, Apple Music, Deezer, or a song.link URL.');
    }
  } else {
    // Text: catalog first (~0.4s) then ytsearch2 focused — usually faster than raw ytsearch3
    return resolveTextSearch(detected.raw);
  }

  // Prefer direct YT URL from song.link without heavy dump-json
  if (meta.youtubeUrl) {
    try {
      const kind = /music\.youtube\.com/i.test(meta.youtubeUrl) ? 'youtubeMusic' : 'youtube';
      const id = extractVideoId(meta.youtubeUrl);
      if (id) {
        const track = trackFromYoutubeId(id, kind, {
          title: meta.title,
          artist: meta.artist,
          album: meta.album,
          durationSec: meta.durationSec,
          artwork: pickAlbumArt(meta.artwork),
        });
        track.fromStub = false;
        track.origin = {
          platform: meta.platform,
          platformUrl: meta.platformUrl,
          resolvedTo: kind === 'youtubeMusic' ? 'YouTube Music' : 'YouTube',
        };
        console.log(`[music] resolved ${meta.platform} via direct YT: ${meta.title} — ${meta.artist}`);
        return track;
      }
    } catch (err) {
      console.warn('[music] direct YT from song.link failed, falling back to search:', err.message);
    }
  }

  const track = await searchYoutubeMusic(meta.searchQueryAlt || meta.searchQuery, meta, { fast: true });
  track.artwork = pickAlbumArt(meta.artwork, track.artwork);
  track.origin = {
    platform: meta.platform,
    platformUrl: meta.platformUrl,
    resolvedTo: 'YouTube Music',
  };
  console.log(`[music] resolved ${meta.platform}: ${meta.title} — ${meta.artist} → ${track.watchUrl}`);
  return track;
}

async function resolveBlockedYoutube(watchUrl, current = {}) {
  const id = extractVideoId(watchUrl);
  let title = current.title;
  let artist = current.artist;
  if (!title || title === 'Unknown') {
    try {
      const oe = await fetchJson(
        `https://www.youtube.com/oembed?url=${encodeURIComponent(
          `https://www.youtube.com/watch?v=${id || watchUrl}`
        )}&format=json`
      );
      if (oe?.title) {
        title = oe.title;
        artist = oe.author_name || artist;
      }
    } catch (_) {}
  }
  const q = [title, artist].filter((x) => x && x !== 'Unknown').join(' ').trim();
  if (!q) throw new Error('This YouTube video is not available.');
  console.log(`[music] YT blocked, search fallback: ${q}`);
  const track = await searchYoutubeMusic(q, { title, artist: artist || '' }, { fast: true });
  if (id && extractVideoId(track.watchUrl) === id) {
    throw new Error('This YouTube video is not available.');
  }
  track.origin = current.origin || track.origin;
  return track;
}



const MAX_PLAYLIST_TRACKS = 50;
const MATCH_CONCURRENCY = 3;

function resolveApi() {
  return {
    parseAppleMusicIds,
    fetchText,
    fetchJson,
    buildSearchMeta,
    pickAlbumArt,
    itunesLookup,
    isYoutubeVideoId,
    searchYoutubeMusic,
  };
}

function spotifyIdFromUrl(url, type) {
  const m = String(url).match(new RegExp(`/${type}/([a-zA-Z0-9]+)`, 'i'));
  return m?.[1] || null;
}

function deezerIdFromUrl(url, type) {
  const m = String(url).match(new RegExp(`/${type}/(\\d+)`, 'i'));
  return m?.[1] || null;
}

function youtubePlaylistId(url) {
  try {
    const u = new URL(url);
    if (/\/playlist/i.test(u.pathname)) return u.searchParams.get('list');
    return null;
  } catch {
    return null;
  }
}

/**
 * Detect playlist / album (multi-track) vs single track.
 */
function detectPlaylistKind(detected) {
  const { parseAppleMusicIds } = resolveApi();
  const href = detected.raw || '';
  const kind = detected.kind;

  if (kind === 'youtube' || kind === 'youtubeMusic') {
    const list = youtubePlaylistId(href);
    if (list) {
      return {
        type: 'youtube',
        id: list,
        platform: kind === 'youtubeMusic' ? 'YouTube Music' : 'YouTube',
        url: href,
      };
    }
    return null;
  }

  if (kind === 'spotify') {
    if (/\/playlist\//i.test(href)) {
      return { type: 'spotifyPlaylist', id: spotifyIdFromUrl(href, 'playlist'), platform: 'Spotify', url: href };
    }
    if (/\/album\//i.test(href)) {
      return { type: 'spotifyAlbum', id: spotifyIdFromUrl(href, 'album'), platform: 'Spotify', url: href };
    }
    return null;
  }

  if (kind === 'deezer') {
    if (/\/playlist\//i.test(href)) {
      return { type: 'deezerPlaylist', id: deezerIdFromUrl(href, 'playlist'), platform: 'Deezer', url: href };
    }
    if (/\/album\//i.test(href)) {
      return { type: 'deezerAlbum', id: deezerIdFromUrl(href, 'album'), platform: 'Deezer', url: href };
    }
    return null;
  }

  if (kind === 'appleMusic') {
    const ids = parseAppleMusicIds(href);
    if (/\/playlist\//i.test(href)) {
      return { type: 'applePlaylist', id: null, platform: 'Apple Music', url: href };
    }
    if (ids.albumId && !ids.trackId) {
      return { type: 'appleAlbum', id: ids.albumId, platform: 'Apple Music', url: href };
    }
    return null;
  }

  return null;
}

async function getSpotifyToken(pageUrl) {
  const { fetchText } = resolveApi();
  const urls = [pageUrl, 'https://open.spotify.com/'].filter(Boolean);
  for (const u of urls) {
    try {
      const html = await fetchText(u);
      const token =
        html.match(/"accessToken":"([^"]+)"/)?.[1] ||
        html.match(/accessToken\\":\\"([^\\]+)\\"/)?.[1];
      if (token) return token;
    } catch {
      /* try next */
    }
  }
  throw new Error('Could not get Spotify access token (page layout changed).');
}

async function spotifyApi(path, token) {
  const res = await fetch(`https://api.spotify.com/v1${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'User-Agent': 'Ditto/1.0',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Spotify API ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function fetchSpotifyTracks(pl, token) {
  const { buildSearchMeta, pickAlbumArt } = resolveApi();
  const isAlbum = pl.type === 'spotifyAlbum';
  const base = isAlbum ? `/albums/${pl.id}` : `/playlists/${pl.id}`;
  const meta = await spotifyApi(base, token);
  const name = meta.name || (isAlbum ? 'Album' : 'Playlist');
  const artwork = pickAlbumArt(meta.images?.[0]?.url);

  const entries = [];
  let path = isAlbum
    ? `/albums/${pl.id}/tracks?limit=50`
    : `/playlists/${pl.id}/tracks?limit=50&fields=items(track(name,artists,album,duration_ms,external_urls)),next`;

  while (path && entries.length < MAX_PLAYLIST_TRACKS) {
    const apiPath = path.startsWith('http') ? path.replace('https://api.spotify.com/v1', '') : path;
    const page = await spotifyApi(apiPath, token);
    const items = page.items || [];
    for (const item of items) {
      if (entries.length >= MAX_PLAYLIST_TRACKS) break;
      const t = isAlbum
        ? {
            name: item.name,
            artists: item.artists,
            duration_ms: item.duration_ms,
            album: { name: meta.name, images: meta.images },
            external_urls: item.external_urls,
          }
        : item.track;
      if (!t || !t.name) continue;
      const artist = (t.artists || []).map((a) => a.name).filter(Boolean).join(', ') || 'Unknown';
      entries.push(
        buildSearchMeta({
          platform: 'Spotify',
          platformUrl: t.external_urls?.spotify || pl.url,
          title: t.name,
          artist,
          album: t.album?.name || meta.name || '',
          artwork: pickAlbumArt(t.album?.images?.[0]?.url, artwork),
          durationSec: t.duration_ms ? Math.round(t.duration_ms / 1000) : null,
        })
      );
    }
    path = page.next || null;
  }

  return { name, artwork, entries, platform: 'Spotify', platformUrl: pl.url };
}

async function fetchDeezerTracks(pl) {
  const { fetchJson, buildSearchMeta, pickAlbumArt } = resolveApi();
  const isAlbum = pl.type === 'deezerAlbum';
  const data = await fetchJson(
    isAlbum
      ? `https://api.deezer.com/album/${pl.id}`
      : `https://api.deezer.com/playlist/${pl.id}`
  );
  if (data.error) throw new Error(data.error.message || 'Deezer playlist not found');

  const name = data.title || (isAlbum ? 'Album' : 'Playlist');
  const artwork = pickAlbumArt(data.cover_xl, data.cover_big, data.picture_xl, data.picture_big);

  let tracks = data.tracks?.data || [];
  // Deezer embeds only ~25 tracks on the parent object — paginate
  if (!isAlbum && data.nb_tracks > tracks.length) {
    tracks = [];
    let index = 0;
    while (tracks.length < MAX_PLAYLIST_TRACKS) {
      const page = await fetchJson(
        `https://api.deezer.com/playlist/${pl.id}/tracks?index=${index}&limit=50`
      );
      const chunk = page.data || [];
      if (!chunk.length) break;
      tracks.push(...chunk);
      index += chunk.length;
      if (!page.next) break;
    }
  }

  const entries = tracks.slice(0, MAX_PLAYLIST_TRACKS).map((t) =>
    buildSearchMeta({
      platform: 'Deezer',
      platformUrl: t.link || pl.url,
      title: t.title,
      artist: t.artist?.name || data.artist?.name || 'Unknown',
      album: t.album?.title || data.title || '',
      artwork: pickAlbumArt(t.album?.cover_xl, artwork),
      durationSec: t.duration || null,
    })
  );
  return { name, artwork, entries, platform: 'Deezer', platformUrl: pl.url };
}

async function fetchAppleAlbumTracks(pl) {
  const { itunesLookup, buildSearchMeta, pickAlbumArt } = resolveApi();
  const results = await itunesLookup(pl.id);
  const collection = results.find((r) => r.wrapperType === 'collection');
  const songs = results.filter((r) => r.wrapperType === 'track').slice(0, MAX_PLAYLIST_TRACKS);
  if (!songs.length) throw new Error('Apple Music album has no tracks.');

  const name = collection?.collectionName || songs[0].collectionName || 'Album';
  const artwork = pickAlbumArt(
    collection?.artworkUrl100?.replace('100x100bb', '600x600bb'),
    songs[0].artworkUrl100?.replace('100x100bb', '600x600bb')
  );
  const entries = songs.map((s) =>
    buildSearchMeta({
      platform: 'Apple Music',
      platformUrl: s.trackViewUrl || pl.url,
      title: s.trackName,
      artist: s.artistName || 'Unknown',
      album: s.collectionName || name,
      artwork: pickAlbumArt(s.artworkUrl100?.replace('100x100bb', '600x600bb'), artwork),
      durationSec: s.trackTimeMillis ? Math.round(s.trackTimeMillis / 1000) : null,
    })
  );
  return { name, artwork, entries, platform: 'Apple Music', platformUrl: pl.url };
}

async function fetchYoutubePlaylistTracks(pl) {
  const { isYoutubeVideoId } = resolveApi();
  const bin = await getYtDlp();
  const { stdout } = await runYtDlp(
    bin,
    [
      pl.url,
      '--flat-playlist',
      '--print',
      '%(id)s|||%(title)s|||%(uploader)s|||%(duration)s',
      '--playlist-end',
      String(MAX_PLAYLIST_TRACKS),
      '--skip-download',
      '--no-warnings',
      '--ignore-errors',
      ...youtubeCompatArgs(),
    ],
    { allowNonZero: true }
  );

  const entries = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [id, title, channel, duration] = trimmed.split('|||');
    const vid = id && id !== 'NA' ? id.split('&')[0] : '';
    if (!isYoutubeVideoId(vid)) continue;
    const dur = duration && duration !== 'NA' ? Number(duration) : null;
    const sourceKind = pl.platform === 'YouTube Music' ? 'youtubeMusic' : 'youtube';
    entries.push({
      ready: true,
      track: {
        title: title && title !== 'NA' ? title : '',
        artist: channel && channel !== 'NA' ? channel : '',
        durationSec: Number.isFinite(dur) ? dur : null,
        album: '',
        url:
          sourceKind === 'youtubeMusic'
            ? `https://music.youtube.com/watch?v=${vid}`
            : `https://www.youtube.com/watch?v=${vid}`,
        watchUrl: `https://www.youtube.com/watch?v=${vid}`,
        sourceKind,
        artwork: null,
        origin: { platform: pl.platform, platformUrl: pl.url },
      },
    });
  }

  if (!entries.length) throw new Error('YouTube playlist is empty or unavailable.');

  let name = 'YouTube playlist';
  try {
    const { stdout: infoOut } = await runYtDlp(
      bin,
      [pl.url, '--dump-single-json', '--flat-playlist', '--playlist-end', '1', '--no-warnings', '--skip-download'],
      { allowNonZero: true }
    );
    const info = JSON.parse(infoOut);
    if (info.title) name = info.title;
  } catch {
    /* keep default */
  }

  return {
    name,
    artwork: null,
    entries,
    platform: pl.platform,
    platformUrl: pl.url,
    alreadyMatched: true,
  };
}

function normQuery(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function scorePlaylistTitle(query, title) {
  const q = normQuery(query);
  const t = normQuery(title);
  if (!q || !t) return 0;
  let score = 0;
  const words = q.split(' ').filter((w) => w.length > 1);
  const hit = words.filter((w) => t.includes(w)).length;
  score += (hit / Math.max(words.length, 1)) * 100;
  if (t === q) score += 40;
  if (t.includes(q) || q.includes(t)) score += 25;
  if (/\bfull album\b|\balbum\b/.test(t)) score += 20;
  if (/\bofficial\b/.test(t)) score += 8;
  if (/\b(mix|mashup|radio|hours|nonstop|nightcore)\b/.test(t)) score -= 35;
  return score;
}

/**
 * Search YouTube playlists by text and load the best match.
 */
async function searchAndLoadYoutubePlaylist(query) {
  const q = String(query || '').trim();
  if (!q) throw new Error('Empty playlist search.');

  console.log(`[music] search YT playlist: ${q}`);
  const bin = await getYtDlp();
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&sp=EgIQAw%3D%3D`;
  const { stdout } = await runYtDlp(
    bin,
    [
      url,
      '--flat-playlist',
      '--playlist-end',
      '8',
      '--print',
      '%(id)s|||%(title)s|||%(url)s',
      '--skip-download',
      '--no-warnings',
      '--ignore-errors',
      ...youtubeCompatArgs(),
    ],
    { allowNonZero: true }
  );

  const candidates = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [id, title, pageUrl] = trimmed.split('|||');
    if (!id || id === 'NA') continue;
    // Playlist ids are usually PL… / OLAK… / RD… — skip plain 11-char videos
    if (/^[A-Za-z0-9_-]{11}$/.test(id) && !id.startsWith('PL')) continue;
    const listUrl =
      pageUrl && pageUrl.includes('list=')
        ? pageUrl
        : `https://www.youtube.com/playlist?list=${id}`;
    candidates.push({
      id,
      title: title && title !== 'NA' ? title : id,
      url: listUrl,
      score: scorePlaylistTitle(q, title),
    });
  }

  if (!candidates.length) {
    throw new Error(`No YouTube playlist found for: ${q}`);
  }

  candidates.sort((a, b) => b.score - a.score);
  console.log(
    '[music] playlist search ranked:',
    candidates
      .slice(0, 4)
      .map((c) => `${c.score.toFixed(0)}:"${c.title}"`)
      .join(' | ')
  );

  const best = candidates[0];
  if (best.score < 40) {
    throw new Error(`No good playlist match for: ${q} (best was "${best.title}")`);
  }

  return loadPlaylist({
    kind: 'youtube',
    raw: best.url,
    url: new URL(best.url),
  });
}

/**
 * Parse "playlist: …" / "pl: …" prefix from a text query.
 * @returns {{ mode: 'playlist'|'track', query: string }}
 */
function parseSearchMode(input) {
  const raw = String(input || '').trim();
  const m = raw.match(/^(?:playlist|pl)\s*[:：]\s*(.+)$/i);
  if (m) return { mode: 'playlist', query: m[1].trim() };
  return { mode: 'track', query: raw };
}

async function matchMetaToTrack(meta) {
  const { searchYoutubeMusic, pickAlbumArt } = resolveApi();
  const track = await searchYoutubeMusic(meta.searchQueryAlt || meta.searchQuery, meta, {
    fast: true,
  });
  track.artwork = pickAlbumArt(meta.artwork, track.artwork);
  track.origin = {
    platform: meta.platform,
    platformUrl: meta.platformUrl,
    resolvedTo: 'YouTube Music',
  };
  return track;
}

async function mapPool(items, concurrency, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return out;
}

async function loadPlaylist(detected) {
  const pl = detectPlaylistKind(detected);
  if (!pl) return null;

  console.log(`[music] playlist detect: ${pl.platform} ${pl.type} ${pl.id || ''}`);

  if (pl.type === 'youtube') {
    return { type: 'playlist', ...(await fetchYoutubePlaylistTracks(pl)) };
  }

  if (pl.type === 'spotifyPlaylist' || pl.type === 'spotifyAlbum') {
    if (!pl.id) throw new Error('Invalid Spotify playlist/album URL.');
    const token = await getSpotifyToken(pl.url);
    return { type: 'playlist', ...(await fetchSpotifyTracks(pl, token)), alreadyMatched: false };
  }

  if (pl.type === 'deezerPlaylist' || pl.type === 'deezerAlbum') {
    if (!pl.id) throw new Error('Invalid Deezer playlist/album URL.');
    return { type: 'playlist', ...(await fetchDeezerTracks(pl)), alreadyMatched: false };
  }

  if (pl.type === 'appleAlbum') {
    return { type: 'playlist', ...(await fetchAppleAlbumTracks(pl)), alreadyMatched: false };
  }

  if (pl.type === 'applePlaylist') {
    throw new Error(
      'Apple Music curated playlist links are not supported yet. Use an album link, or a Spotify / Deezer / YouTube playlist.'
    );
  }

  return null;
}

async function resolveFirstPlaylistTrack(playlist) {
  const entry = playlist.entries[0];
  if (!entry) throw new Error('Playlist is empty.');
  if (entry.ready && entry.track) return entry.track;
  return matchMetaToTrack(entry);
}

async function resolvePlaylistRest(playlist, onTrack) {
  const rest = playlist.entries.slice(1);
  if (!rest.length) return { ok: 0, fail: 0 };

  let ok = 0;
  let fail = 0;

  if (playlist.alreadyMatched) {
    for (const entry of rest) {
      if (entry.ready && entry.track) {
        await onTrack(entry.track);
        ok++;
      }
    }
    return { ok, fail };
  }

  await mapPool(rest, MATCH_CONCURRENCY, async (meta, idx) => {
    try {
      const track = await matchMetaToTrack(meta);
      await onTrack(track);
      ok++;
      if ((idx + 1) % 5 === 0) {
        console.log(`[music] playlist matched ${idx + 2}/${playlist.entries.length}`);
      }
    } catch (err) {
      fail++;
      console.warn(`[music] playlist skip "${meta.title}": ${err.message}`);
    }
  });

  return { ok, fail };
}



module.exports = {
  detectUrlKind,
  resolvePlayQuery,
  resolvePlayInput,
  pickAlbumArt,
  buildSearchMeta,
  searchYoutubeMusic,
  resolveBlockedYoutube,
  getYoutubeInfo,
  hydrateYoutubeMeta,
  fetchJson,
  fetchText,
  itunesLookup,
  parseAppleMusicIds,
  isYoutubeVideoId,
  MAX_PLAYLIST_TRACKS,
  detectPlaylistKind,
  loadPlaylist,
  resolveFirstPlaylistTrack,
  resolvePlaylistRest,
  matchMetaToTrack,
  searchAndLoadYoutubePlaylist,
  parseSearchMode,
};
