const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { PassThrough } = require('stream');
const https = require('https');
const http = require('http');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  getVoiceConnection,
  NoSubscriberBehavior,
  StreamType,
} = require('@discordjs/voice');
require('libsodium-wrappers');
const prism = require('prism-media');


let resolved = null;

function tryStatic() {
  try {
    const ffmpegStatic = require('ffmpeg-static');
    if (ffmpegStatic && fs.existsSync(ffmpegStatic)) return ffmpegStatic;
  } catch (_) {}
  return null;
}

function tryPath() {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return 'ffmpeg';
  } catch (_) {
    return null;
  }
}

/**
 * Prefer system FFmpeg (Pterodactyl eggs usually ship it),
 * then FFMPEG_PATH, then ffmpeg-static if the binary was installed.
 */
function getFfmpegPath() {
  if (resolved) return resolved;

  if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) {
    resolved = process.env.FFMPEG_PATH;
  } else {
    resolved = tryPath() || tryStatic();
  }

  if (resolved && resolved !== 'ffmpeg') {
    process.env.FFMPEG_PATH = resolved;
  }

  return resolved;
}

function ensureFfmpeg() {
  const bin = getFfmpegPath();
  if (!bin) {
    throw new Error(
      'FFmpeg not found. On Pterodactyl, use a Discord bot egg with FFmpeg, or set FFMPEG_PATH.'
    );
  }
  return bin;
}

function getTempDir() {
  const dir = path.join(process.cwd(), 'tmp', 'music');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}



const BIN_DIR = path.join(process.cwd(), 'bin');

function binaryName() {
  return process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
}

function localBinaryPath() {
  return path.join(BIN_DIR, binaryName());
}

function downloadUrl() {
  if (process.platform === 'win32') {
    return 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';
  }
  if (process.platform === 'darwin') {
    return 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos';
  }
  return 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';
}

function findSystemYtDlp() {
  for (const bin of ['yt-dlp', 'youtube-dl']) {
    try {
      execFileSync(bin, ['--version'], { stdio: 'ignore' });
      return bin;
    } catch (_) {}
  }
  return null;
}

function findBundledYtDlp() {
  // youtube-dl-exec stores binary here when postinstall ran
  try {
    const ytdl = require('youtube-dl-exec');
    if (typeof ytdl === 'string' && fs.existsSync(ytdl)) return ytdl;
    if (ytdl?.path && fs.existsSync(ytdl.path)) return ytdl.path;
  } catch (_) {}

  const candidates = [
    path.join(process.cwd(), 'node_modules', 'youtube-dl-exec', 'bin', 'yt-dlp'),
    path.join(process.cwd(), 'node_modules', 'youtube-dl-exec', 'bin', 'yt-dlp.exe'),
    path.join(process.cwd(), 'node_modules', 'youtube-dl-exec', 'bin', binaryName()),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function followDownload(url, dest) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(
      url,
      {
        headers: { 'User-Agent': 'Ditto/1.0' },
        timeout: 120000,
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          followDownload(res.headers.location, dest).then(resolve).catch(reject);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`Download failed HTTP ${res.statusCode}`));
          res.resume();
          return;
        }
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        const out = fs.createWriteStream(dest);
        res.pipe(out);
        out.on('finish', () => {
          out.close(() => {
            try {
              if (process.platform !== 'win32') fs.chmodSync(dest, 0o755);
            } catch (_) {}
            resolve(dest);
          });
        });
        out.on('error', reject);
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Download timed out'));
    });
  });
}

let cached = null;
let downloading = null;

/**
 * Returns a path/command to yt-dlp, downloading into ./bin if needed.
 */
async function getYtDlp() {
  if (cached) return cached;

  const system = findSystemYtDlp();
  if (system) {
    cached = system;
    return cached;
  }

  const bundled = findBundledYtDlp();
  if (bundled) {
    cached = bundled;
    return cached;
  }

  const local = localBinaryPath();
  if (fs.existsSync(local)) {
    cached = local;
    return cached;
  }

  if (!downloading) {
    console.log('[music] downloading yt-dlp binary into ./bin …');
    downloading = followDownload(downloadUrl(), local)
      .then((p) => {
        console.log('[music] yt-dlp ready:', p);
        cached = p;
        return p;
      })
      .finally(() => {
        downloading = null;
      });
  }
  return downloading;
}

/**
 * YouTube 2026: without a JS runtime, yt-dlp only uses android_vr and many
 * videos (kids / Disney / some Music) return "This video is not available".
 * Node is always present on Pterodactyl. Prefer web_safari/tv/mweb.
 */
function youtubeCompatArgs() {
  return [
    '--js-runtimes',
    'node',
    '--extractor-args',
    'youtube:player_client=web_safari,tv,mweb,android_vr',
    '--user-agent',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    '--geo-bypass',
  ];
}

function canonicalWatchUrl(watchUrl) {
  const id = extractVideoId(watchUrl);
  if (id) return `https://www.youtube.com/watch?v=${id}`;
  return String(watchUrl || '');
}

function watchUrlVariants(watchUrl) {
  const id = extractVideoId(watchUrl);
  const raw = String(watchUrl || '');
  const variants = [];
  if (id) {
    variants.push(`https://www.youtube.com/watch?v=${id}`);
    variants.push(`https://music.youtube.com/watch?v=${id}`);
    variants.push(`https://www.youtube.com/watch?v=${id}&bpctr=9999999999&has_verified=1`);
  }
  if (raw && !variants.includes(raw)) variants.unshift(raw);
  return [...new Set(variants)];
}

function runYtDlp(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: opts.stdio || ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeoutMs = opts.timeoutMs || 0;
    let timer = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          child.kill('SIGKILL');
        } catch (_) {}
        reject(new Error(`yt-dlp timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }
    if (child.stdout) {
      child.stdout.on('data', (d) => {
        stdout += d.toString();
      });
    }
    if (child.stderr) {
      child.stderr.on('data', (d) => {
        stderr += d.toString();
      });
    }
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr, code });
      else if (opts.allowNonZero && stdout.trim()) resolve({ stdout, stderr, code });
      else reject(new Error(`yt-dlp exited ${code}: ${stderr.slice(0, 400) || stdout.slice(0, 400)}`));
    });
  });
}

const STREAM_CACHE_TTL_MS = 3 * 60 * 60 * 1000;
const streamCache = new Map(); // videoId -> result
const streamInflight = new Map(); // key -> Promise

function extractVideoId(watchUrl) {
  try {
    const u = new URL(watchUrl);
    if (u.hostname.includes('youtu.be')) {
      return u.pathname.replace(/^\//, '').slice(0, 11);
    }
    const v = u.searchParams.get('v');
    if (v) return v.slice(0, 11);
  } catch (_) {}
  const m = String(watchUrl).match(/[?&]v=([A-Za-z0-9_-]{11})/);
  return m?.[1] || null;
}

async function getDirectAudioUrl(watchUrl) {
  const meta = await getStreamAndMeta(watchUrl);
  return meta.streamUrl;
}

function parseStreamPrint(stdout, fallbackId) {
  const lines = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  let videoId = fallbackId;
  let title = 'Unknown';
  let artist = 'Unknown';
  let durationSec = null;
  let streamUrl = null;

  for (const line of lines) {
    if (!line.includes('|||')) {
      if (/^https?:\/\//i.test(line)) streamUrl = streamUrl || line;
      continue;
    }
    const [mid, mtitle, mchannel, mdur, murl] = line.split('|||');
    if (mid && mid !== 'NA' && /^[A-Za-z0-9_-]{11}$/.test(mid.split('&')[0])) {
      videoId = mid.split('&')[0];
    }
    if (mtitle && mtitle !== 'NA') title = mtitle;
    if (mchannel && mchannel !== 'NA') artist = mchannel;
    const dur = mdur && mdur !== 'NA' ? Number(mdur) : null;
    if (Number.isFinite(dur)) durationSec = dur;
    if (murl && /^https?:\/\//i.test(murl)) streamUrl = murl;
  }

  if (!streamUrl) streamUrl = lines.find((l) => /^https?:\/\//i.test(l));
  if (!streamUrl) return null;

  return {
    streamUrl,
    videoId: videoId || fallbackId,
    title,
    artist,
    durationSec,
    expires: Date.now() + STREAM_CACHE_TTL_MS,
    fromCache: false,
  };
}

async function extractOnce(bin, url, format) {
  const args = [
    ...(format ? ['-f', format] : []),
    '--print',
    '%(id)s|||%(title)s|||%(uploader|channel|artist)s|||%(duration)s|||%(url)s',
    '--no-playlist',
    '--no-warnings',
    '--skip-download',
    '--socket-timeout',
    '15',
    ...youtubeCompatArgs(),
    url,
  ];
  const { stdout } = await runYtDlp(bin, args, { allowNonZero: true, timeoutMs: 35_000 });
  return parseStreamPrint(stdout, extractVideoId(url));
}

/**
 * One yt-dlp call: direct audio URL + title/artist/duration.
 * Cached by videoId (~3h). Dedupes in-flight (prefetch + play share one call).
 */
async function getStreamAndMeta(watchUrl) {
  const id = extractVideoId(watchUrl);
  const cacheKey = id || String(watchUrl);

  if (id) {
    const hit = streamCache.get(id);
    if (hit && hit.expires > Date.now() && hit.streamUrl) {
      console.log(`[music] stream cache hit: ${id}`);
      return { ...hit, videoId: id, fromCache: true };
    }
  }

  if (streamInflight.has(cacheKey)) {
    console.log(`[music] stream inflight wait: ${cacheKey}`);
    return streamInflight.get(cacheKey);
  }

  const job = (async () => {
    const bin = await getYtDlp();
    const formats = ['bestaudio/best/18', 'best/18', null];
    const urls = watchUrlVariants(watchUrl);
    let lastErr = null;

    for (const url of urls) {
      for (const format of formats) {
        try {
          const parsed = await extractOnce(bin, url, format);
          if (parsed?.streamUrl) {
            if (parsed.videoId) streamCache.set(parsed.videoId, parsed);
            console.log(`[music] stream via ${format || 'any'} ${url.includes('music.') ? 'YT Music' : 'YT'}`);
            return parsed;
          }
        } catch (err) {
          lastErr = err;
          const msg = err.message || '';
          if (/DRM protected/i.test(msg)) continue;
          if (/not available|Requested format|unavailable/i.test(msg)) continue;
          // Network / timeout: still try next variant
        }
      }
    }

    throw lastErr || new Error('yt-dlp did not return a stream URL');
  })();

  streamInflight.set(cacheKey, job);
  try {
    return await job;
  } finally {
    streamInflight.delete(cacheKey);
  }
}

function prefetchStream(watchUrl) {
  return getStreamAndMeta(watchUrl).catch((err) => {
    console.warn('[music] prefetch failed:', err.message);
    return null;
  });
}

async function updateYtDlp() {
  try {
    const bin = await getYtDlp();
    await runYtDlp(bin, ['-U'], { allowNonZero: true, timeoutMs: 90_000 });
    console.log('[music] yt-dlp self-update done');
  } catch (err) {
    console.warn('[music] yt-dlp -U skipped:', err.message.slice(0, 160));
  }
}


const COLORS = {
  play: 0x1db954,
  nowPlaying: 0xff0033,
  queue: 0x5865f2,
  skip: 0xfee75c,
  pause: 0xe67e22,
  resume: 0x57f287,
  volume: 0x9b59b6,
  stop: 0xed4245,
  settings: 0x99aab5,
  error: 0xed4245,
};

function bt(text) {
  return `\`${String(text).replace(/`/g, "'")}\``;
}

function mdLink(label, url) {
  if (!url) return label;
  return `[${label}](${url})`;
}

function isYoutubeClipThumb(url) {
  if (!url) return false;
  return /i\.ytimg\.com|img\.youtube\.com/i.test(url);
}

function extractYoutubeVideoId(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.hostname.includes('youtu.be')) {
      const id = u.pathname.replace(/^\//, '').slice(0, 11);
      return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
    }
    const v = u.searchParams.get('v');
    if (v && /^[A-Za-z0-9_-]{11}$/.test(v.slice(0, 11))) return v.slice(0, 11);
  } catch (_) {}
  const m = String(url).match(/(?:v=|\/embed\/|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  return m?.[1] || null;
}

function youtubeThumbUrl(videoId) {
  if (!videoId) return null;
  return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}

/** Album art if we have it, otherwise the YouTube video thumbnail. */
function displayArtwork(track) {
  const art = track?.artwork;
  if (art && !isYoutubeClipThumb(art)) return art;
  const id = extractYoutubeVideoId(track?.watchUrl || track?.url);
  if (id) return youtubeThumbUrl(id);
  return art || null;
}

/** Empty / placeholder metadata — do not show "Unknown". */
function realMeta(value) {
  const s = String(value ?? '').trim();
  if (!s) return '';
  if (/^(unknown|n\/?a|null|undefined)$/i.test(s)) return '';
  return s;
}



const DATA_DIR = path.join(process.cwd(), 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'guild-settings.json');

const DEFAULTS = {
  playbackMode: 'stream', // 'stream' | 'tempDownload'
  linkResolution: 'youtubeMusic', // fixed in v1
  defaultVolume: 50,
};

function ensureStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(SETTINGS_FILE)) {
    fs.writeFileSync(SETTINGS_FILE, '{}', 'utf8');
  }
}

function readAll() {
  ensureStore();
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeAll(data) {
  ensureStore();
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function getGuildSettings(guildId) {
  const all = readAll();
  return { ...DEFAULTS, ...(all[guildId] || {}) };
}

function setGuildSetting(guildId, key, value) {
  const all = readAll();
  const current = { ...DEFAULTS, ...(all[guildId] || {}) };
  current[key] = value;
  all[guildId] = current;
  writeAll(all);
  return current;
}

const PLAYBACK_MODE_LABELS = {
  stream: 'Stream',
  tempDownload: 'Temp download',
};

const LINK_RESOLUTION_LABELS = {
  youtubeMusic: 'YouTube Music priority',
};



const META_TIMEOUT_MS = 700;
const ART_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const artCache = new Map(); // key -> { artwork, album, genre, expires }

function normalizeKey(title, artist) {
  return `${String(title || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()}|${String(artist || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()}`;
}

function safeAlbumArt(url) {
  if (!url || isYoutubeClipThumb(url)) return null;
  return url;
}

function itunesArtUrl(url100) {
  if (!url100) return null;
  return String(url100).replace('100x100bb', '600x600bb');
}

async function fetchJsonTimeout(url, ms = META_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Ditto/1.0' },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

function scoreCatalogHit(query, hit) {
  const q = String(query || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const title = String(hit.title || '').toLowerCase();
  const artist = String(hit.artist || '').toLowerCase();
  const hay = `${title} ${artist}`;
  let score = 0;
  const words = q.split(' ').filter((w) => w.length > 1);
  for (const w of words) {
    if (hay.includes(w)) score += 20;
    if (title.includes(w)) score += 10;
  }
  if (title && q.includes(title)) score += 30;
  if (hit.artwork) score += 15;
  if (hit.durationSec) score += 5;
  if (hit.genre) score += 3;
  return score;
}

function fromDeezerTrack(t) {
  return {
    title: t.title || 'Unknown',
    artist: t.artist?.name || 'Unknown',
    album: t.album?.title || '',
    durationSec: t.duration || null,
    genre: null,
    artwork: safeAlbumArt(t.album?.cover_xl || t.album?.cover_big || t.album?.cover_medium),
    source: 'deezer',
  };
}

function fromItunesTrack(t) {
  return {
    title: t.trackName || 'Unknown',
    artist: t.artistName || 'Unknown',
    album: t.collectionName || '',
    durationSec: t.trackTimeMillis ? Math.round(t.trackTimeMillis / 1000) : null,
    genre: t.primaryGenreName || null,
    artwork: safeAlbumArt(itunesArtUrl(t.artworkUrl100)),
    source: 'itunes',
  };
}

async function searchDeezer(query) {
  const data = await fetchJsonTimeout(
    `https://api.deezer.com/search?q=${encodeURIComponent(query)}&limit=5`
  );
  return (data.data || []).map(fromDeezerTrack);
}

async function searchItunes(query) {
  const data = await fetchJsonTimeout(
    `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&media=music&entity=song&limit=5`
  );
  return (data.results || [])
    .filter((r) => r.wrapperType === 'track' || r.kind === 'song')
    .map(fromItunesTrack);
}

/**
 * Parallel Deezer + iTunes catalog search. Picks best hit for metadata + album art.
 */
async function searchCatalog(query, opts = {}) {
  const q = String(query || '').trim();
  if (!q) return null;

  const [deezer, itunes] = await Promise.all([
    searchDeezer(q).catch(() => []),
    searchItunes(q).catch(() => []),
  ]);

  void opts;

  const hits = [...deezer, ...itunes]
    .map((h) => ({ h, score: scoreCatalogHit(q, h) }))
    .sort((a, b) => b.score - a.score);

  if (!hits.length || hits[0].score < 25) return null;

  const best = hits[0].h;
  const withArt = hits.find((x) => x.h.artwork && x.score >= hits[0].score - 20);
  const chosen = withArt?.h || best;

  const key = normalizeKey(chosen.title, chosen.artist);
  if (chosen.artwork) {
    artCache.set(key, {
      artwork: chosen.artwork,
      album: chosen.album,
      genre: chosen.genre,
      expires: Date.now() + ART_CACHE_TTL_MS,
    });
  }

  console.log(
    `[music] catalog → ${chosen.title} — ${chosen.artist} (${chosen.source}${chosen.artwork ? '+art' : ''})`
  );
  return chosen;
}

/**
 * Fast album art for known title/artist. Never returns YouTube clip thumbs.
 */
async function fetchAlbumArtFast(title, artist, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? META_TIMEOUT_MS;
  const key = normalizeKey(title, artist);
  const cached = artCache.get(key);
  if (cached && cached.expires > Date.now()) {
    return {
      artwork: cached.artwork,
      album: cached.album || '',
      genre: cached.genre || null,
    };
  }

  const q = [title, artist].filter((x) => x && x !== 'Unknown').join(' ').trim();
  if (!q) return { artwork: null, album: '', genre: null };

  try {
    const hit = await Promise.race([
      searchCatalog(q, { timeoutMs }),
      new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs + 50)),
    ]);
    if (!hit) return { artwork: null, album: '', genre: null };
    return {
      artwork: safeAlbumArt(hit.artwork),
      album: hit.album || '',
      genre: hit.genre || null,
    };
  } catch {
    return { artwork: null, album: '', genre: null };
  }
}

async function enrichTrackFromCatalog(track, opts = {}) {
  if (track.artwork && !isYoutubeClipThumb(track.artwork)) {
    return track;
  }
  const art = await fetchAlbumArtFast(track.title, track.artist, opts);
  if (art.artwork) track.artwork = art.artwork;
  if (art.album && !track.album) track.album = art.album;
  if (art.genre && !track.genre) track.genre = art.genre;
  if (isYoutubeClipThumb(track.artwork)) track.artwork = null;
  return track;
}



function hydrateYoutubeMeta(track, timeoutMs) {
  return require('./resolve').hydrateYoutubeMeta(track, timeoutMs);
}


const guildPlayers = new Map();

/** ~4s of s16le stereo 48kHz — covers YouTube hiccups without muting Discord. */
const PCM_BUFFER_BYTES = 48000 * 2 * 2 * 4;
const YTDLP_PREBUFFER_BYTES = 512 * 1024;

let nativeOpusCached = null;
function hasNativeOpus() {
  if (nativeOpusCached !== null) return nativeOpusCached;
  try {
    require('@discordjs/opus');
    nativeOpusCached = true;
  } catch (_) {
    nativeOpusCached = false;
  }
  return nativeOpusCached;
}

let libopusCached = null;
function ffmpegHasLibopus() {
  if (libopusCached !== null) return libopusCached;
  try {
    const info = prism.FFmpeg.getInfo();
    const blob = `${info.output || ''} ${info.version || ''}`;
    libopusCached = blob.includes('libopus');
  } catch (_) {
    libopusCached = false;
  }
  return libopusCached;
}

function createDiscordResourceFromPcm(pcmBuf, guildMusic, getStderr) {
  if (hasNativeOpus()) {
    console.log('[music] opus encoder=@discordjs/opus');
    const resource = createAudioResource(pcmBuf, {
      inputType: StreamType.Raw,
      inlineVolume: true,
      silencePaddingFrames: 5,
    });
    resource._ffmpegStderr = getStderr;
    return resource;
  }

  if (ffmpegHasLibopus()) {
    console.log('[music] opus encoder=ffmpeg libopus');
    const vol = Math.max(0.01, (guildMusic.volume || 50) / 100);
    const volume = new prism.VolumeTransformer({
      type: 's16le',
      volume: vol,
      highWaterMark: PCM_BUFFER_BYTES,
    });
    pcmBuf.pipe(volume);

    const ffmpegBin = getFfmpegPath() || 'ffmpeg';
    const opus = spawn(
      ffmpegBin,
      [
        '-f', 's16le',
        '-ar', '48000',
        '-ac', '2',
        '-thread_queue_size', '2048',
        '-i', 'pipe:0',
        '-c:a', 'libopus',
        '-b:a', '96k',
        '-vbr', 'on',
        '-application', 'audio',
        '-frame_duration', '20',
        '-loglevel', 'error',
        '-f', 'ogg',
        'pipe:1',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
    );

    volume.pipe(opus.stdin);
    opus.stdin.on('error', () => {});
    guildMusic._opusChild = opus;

    let opusErr = '';
    opus.stderr.on('data', (chunk) => {
      opusErr += chunk.toString();
      if (opusErr.length > 1000) opusErr = opusErr.slice(-1000);
    });
    opus.on('close', (code) => {
      if (guildMusic._opusChild === opus) guildMusic._opusChild = null;
      if (code && code !== 0) {
        console.error('[music] opus ffmpeg exit', code, opusErr.slice(0, 300));
      }
    });

    const resource = createAudioResource(opus.stdout, {
      inputType: StreamType.OggOpus,
    });
    resource.volume = volume;
    resource._ffmpegStderr = () => `${getStderr()}\n${opusErr}`.trim();
    return resource;
  }

  console.warn('[music] opus encoder=opusscript (JS) — stutter possible');
  const resource = createAudioResource(pcmBuf, {
    inputType: StreamType.Raw,
    inlineVolume: true,
    silencePaddingFrames: 5,
  });
  resource._ffmpegStderr = getStderr;
  return resource;
}

/**
 * Always transcode through FFmpeg → raw PCM s16le 48kHz stereo.
 * Direct googlevideo URLs often 403; for YouTube we pipe yt-dlp → ffmpeg instead.
 */
function attachFfmpegProcess(child, guildMusic) {
  guildMusic._child = child;
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
    if (stderr.length > 2000) stderr = stderr.slice(-2000);
  });
  child.on('error', (err) => {
    console.error('[music] ffmpeg spawn error:', err.message);
  });
  child.on('close', (code) => {
    if (guildMusic._child === child) guildMusic._child = null;
    if (code && code !== 0) {
      console.error('[music] ffmpeg exit', code, stderr.slice(0, 500));
    }
  });
  const pcmBuf = new PassThrough({ highWaterMark: PCM_BUFFER_BYTES });
  child.stdout.pipe(pcmBuf);
  return createDiscordResourceFromPcm(pcmBuf, guildMusic, () => stderr);
}

function createFfmpegPcmResource(inputUrl, guildMusic) {
  const ffmpegBin = getFfmpegPath() || 'ffmpeg';
  const isHttp = /^https?:\/\//i.test(inputUrl);
  const args = [
    ...(isHttp
      ? [
          '-reconnect', '1',
          '-reconnect_streamed', '1',
          '-reconnect_delay_max', '5',
          '-user_agent',
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          '-referer', 'https://www.youtube.com/',
        ]
      : []),
    '-i', inputUrl,
    '-analyzeduration', '0',
    '-loglevel', 'error',
    '-vn',
    '-f', 's16le',
    '-ar', '48000',
    '-ac', '2',
    'pipe:1',
  ];

  console.log(`[music] ffmpeg PCM via ${ffmpegBin}${isHttp ? ' (url+headers)' : ''}`);
  const child = spawn(ffmpegBin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  return attachFfmpegProcess(child, guildMusic);
}

/**
 * yt-dlp → RAM fifo → ffmpeg PCM.
 * YouTube JS extraction often takes 5–15s on Pterodactyl — wait for real bytes
 * before starting FFmpeg (never open an empty pipe).
 */
function createPipedYtDlpResource(watchUrl, guildMusic, ytdlpBin) {
  return new Promise((resolve, reject) => {
    const ffmpegBin = getFfmpegPath() || 'ffmpeg';
    const ytdlpArgs = [
      '-f',
      'bestaudio[ext=m4a]/bestaudio/18/best',
      '--no-playlist',
      '--no-warnings',
      '--no-progress',
      '--no-part',
      '--no-mtime',
      '--retries',
      '15',
      '--fragment-retries',
      '15',
      '--buffer-size',
      '64K',
      ...youtubeCompatArgs(),
      '-o',
      '-',
      watchUrl,
    ];

    console.log(`[music] ffmpeg PCM via yt-dlp pipe (${ffmpegBin})`);
    const ytdlp = spawn(ytdlpBin, ytdlpArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const fifo = new PassThrough({ highWaterMark: 2 * 1024 * 1024 });
    ytdlp.stdout.pipe(fifo);
    ytdlp.stdout.on('error', () => {});

    let started = false;
    let settled = false;
    let sawDataAt = 0;
    const t0 = Date.now();

    const ytdlpErr = { text: '' };
    ytdlp.stderr.on('data', (chunk) => {
      ytdlpErr.text += chunk.toString();
      if (ytdlpErr.text.length > 2000) ytdlpErr.text = ytdlpErr.text.slice(-2000);
    });

    const poll = setInterval(() => {
      if (started || settled) {
        clearInterval(poll);
        return;
      }
      const n = fifo.readableLength;
      if (n <= 0) return;
      if (!sawDataAt) {
        sawDataAt = Date.now();
        console.log(`[music] yt-dlp first byte after ${sawDataAt - t0}ms (${Math.round(n / 1024)}KB)`);
      }
      if (n >= YTDLP_PREBUFFER_BYTES || Date.now() - sawDataAt >= 1200) {
        clearInterval(poll);
        startFfmpeg();
      }
    }, 30);

    function fail(err) {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(giveUpTimer);
      try {
        ytdlp.kill('SIGKILL');
      } catch (_) {}
      const hint = ytdlpErr.text.replace(/\s+/g, ' ').trim().slice(0, 300);
      reject(hint ? new Error(`${err.message} (${hint})`) : err);
    }

    function startFfmpeg() {
      if (started || settled) return;
      if (fifo.readableLength <= 0) return;
      started = true;
      clearInterval(poll);
      clearTimeout(giveUpTimer);
      console.log(`[music] prebuffer ready (${Math.round(fifo.readableLength / 1024)}KB)`);

      const ffmpeg = spawn(
        ffmpegBin,
        [
          '-thread_queue_size',
          '1024',
          '-probesize',
          '256000',
          '-analyzeduration',
          '500000',
          '-loglevel',
          'error',
          '-i',
          'pipe:0',
          '-vn',
          '-af',
          'aresample=async=1:first_pts=0',
          '-f',
          's16le',
          '-ar',
          '48000',
          '-ac',
          '2',
          'pipe:1',
        ],
        { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
      );

      ffmpeg.stdin.on('error', () => {});
      fifo.pipe(ffmpeg.stdin);

      ytdlp.on('close', (code) => {
        if (code && code !== 0) {
          console.error('[music] yt-dlp pipe exit', code, ytdlpErr.text.slice(0, 400));
        }
      });

      guildMusic._ytdlpChild = ytdlp;
      const resource = attachFfmpegProcess(ffmpeg, guildMusic);
      const prev = resource._ffmpegStderr;
      resource._ffmpegStderr = () => `${prev?.() || ''}\n${ytdlpErr.text}`.trim();
      settled = true;
      resolve(resource);
    }

    ytdlp.on('error', (err) => fail(err));
    ytdlp.on('close', (code) => {
      if (started || settled) return;
      if (fifo.readableLength > 0) startFfmpeg();
      else fail(new Error(`yt-dlp exited ${code ?? 0} with no audio data`));
    });

    const giveUpTimer = setTimeout(() => {
      if (started || settled) return;
      if (fifo.readableLength > 0) startFfmpeg();
      else fail(new Error('yt-dlp produced no audio data'));
    }, 45_000);
  });
}

class GuildMusic {
  constructor(guildId) {
    this.guildId = guildId;
    this.queue = [];
    this.current = null;
    this.player = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Play,
        // 20ms * 25 = 500ms of silence before giving up (default 100ms cuts the track)
        maxMissedFrames: 25,
      },
    });
    this.connection = null;
    this.volume = 50;
    this.paused = false;
    this.tempFile = null;
    this.startedAt = null;
    this.pausedAt = null;
    this.accumulatedPauseMs = 0;
    this.textChannel = null;
    this._child = null;
    this._ytdlpChild = null;
    this._opusChild = null;
    this._ignoreIdle = false;
    this.skipVotes = new Set();
    this.stopVotes = new Set();
    this._playNextLock = false;
    this._playGen = 0;
    this._idleArmed = false;

    this.player.on(AudioPlayerStatus.Playing, () => {
      console.log(`[music] PLAYING: ${this.current?.title || '?'}`);
      this._idleArmed = true;
    });

    this.player.on(AudioPlayerStatus.Buffering, () => {
      console.log('[music] buffering…');
    });

    this.player.on(AudioPlayerStatus.Idle, () => {
      if (this._ignoreIdle || this._playNextLock || !this._idleArmed) return;
      this._idleArmed = false;
      console.log('[music] idle (track ended or stream died)');
      this._cleanupTemp();
      this._killChild();
      this._playNext().catch((err) => console.error('[music] playNext error:', err.message));
    });

    this.player.on('error', (err) => {
      console.error('[music] player error:', err.message);
      if (this._ignoreIdle || this._playNextLock) return;
      const currentRes = this.player.state.resource;
      if (err.resource && currentRes && err.resource !== currentRes) return;
      this._cleanupTemp();
      this._killChild();
      this._playNext().catch(() => {});
    });
  }

  getElapsedSec() {
    if (!this.startedAt) return 0;
    let ms = Date.now() - this.startedAt - this.accumulatedPauseMs;
    if (this.paused && this.pausedAt) ms -= Date.now() - this.pausedAt;
    return Math.max(0, Math.floor(ms / 1000));
  }

  async ensureConnection(voiceChannel) {
    ensureFfmpeg();

    const me = voiceChannel.guild.members.me;
    const perms = voiceChannel.permissionsFor(me);
    if (perms) {
      if (!perms.has('Connect')) throw new Error('Bot missing Connect permission in that voice channel.');
      if (!perms.has('Speak')) throw new Error('Bot missing Speak permission in that voice channel.');
    }

    const existing = getVoiceConnection(this.guildId);
    if (existing && existing.joinConfig.channelId === voiceChannel.id) {
      this.connection = existing;
      this.connection.subscribe(this.player);
      return this.connection;
    }

    if (existing) {
      try {
        existing.destroy();
      } catch (_) {}
    }

    this.connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: false,
    });

    const subscription = this.connection.subscribe(this.player);
    if (!subscription) {
      throw new Error('Failed to subscribe audio player to the voice connection.');
    }

    try {
      await entersState(this.connection, VoiceConnectionStatus.Ready, 20_000);
    } catch (err) {
      try {
        this.connection.destroy();
      } catch (_) {}
      this.connection = null;
      throw new Error(`Could not join voice channel: ${err.message}`);
    }

    this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(this.connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(this.connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        try {
          this.connection?.destroy();
        } catch (_) {}
        this.connection = null;
      }
    });

    console.log(`[music] joined voice ${voiceChannel.name} (${voiceChannel.id})`);
    return this.connection;
  }

  enqueue(track) {
    if (!track) return this.queueSize();
    this.queue = this.queue.filter((t) => t !== track && t !== this.current);
    this.queue.push(track);
    return this.positionOf(track);
  }

  /** Enqueue many tracks (already resolved). Returns first position. */
  enqueueMany(tracks) {
    if (!tracks.length) return 0;
    let first = 0;
    for (const t of tracks) {
      const pos = this.enqueue(t);
      if (!first) first = pos;
    }
    return first;
  }

  positionOf(track) {
    if (this.current && track && this.current === track) return 1;
    const idx = this.queue.indexOf(track);
    const ahead = this.current ? 1 : 0;
    if (idx >= 0) return ahead + idx + 1;
    return ahead + this.queue.length;
  }

  queueSize() {
    return (this.current ? 1 : 0) + this.queue.length;
  }

  async playOrEnqueue(track, voiceChannel, textChannel) {
    const settings = getGuildSettings(this.guildId);
    if (!this.current && this.queue.length === 0) {
      this.volume = settings.defaultVolume;
    }

    this.textChannel = textChannel || this.textChannel;

    const busy =
      this._playNextLock ||
      this.current ||
      this.player.state.status === AudioPlayerStatus.Playing ||
      this.player.state.status === AudioPlayerStatus.Paused ||
      this.player.state.status === AudioPlayerStatus.Buffering;

    if (!busy) {
      this.queue = this.queue.filter((t) => t !== track);
      this.current = track;
      await this._startCurrent(voiceChannel);
      this._prefetchNext();
      return { position: 1, started: true };
    }

    await this.ensureConnection(voiceChannel);
    const position = this.enqueue(track);
    hydrateYoutubeMeta(track, 800).catch(() => {});
    this._prefetchNext();
    return { position, started: false };
  }

  /**
   * Start first track (or enqueue if busy), then append the rest.
   */
  async playOrEnqueuePlaylist(firstTrack, restTracks, voiceChannel, textChannel) {
    const result = await this.playOrEnqueue(firstTrack, voiceChannel, textChannel);
    if (restTracks?.length) this.enqueueMany(restTracks);
    this._prefetchNext();
    return {
      ...result,
      queued: 1 + (restTracks?.length || 0),
    };
  }

  _prefetchNext() {
    const next = this.queue[0];
    if (!next) return;
    const url = next.watchUrl || next.url;
    if (url) prefetchStream(url);
  }

  async _startCurrent(voiceChannel = null) {
    if (!this.current) return;
    this.queue = this.queue.filter((t) => t !== this.current);
    ensureFfmpeg();

    const settings = getGuildSettings(this.guildId);
    const mode = settings.playbackMode || 'stream';
    const url = this.current.watchUrl || this.current.url;

    this._cleanupTemp();
    this._killChild();
    this.resetControlVotes();
    this.paused = false;
    this.pausedAt = null;
    this.accumulatedPauseMs = 0;
    this.startedAt = Date.now();

    console.log(`[music] starting (${mode}): ${url}`);

    let resource;
    try {
      if (mode === 'tempDownload') {
        if (voiceChannel) await this.ensureConnection(voiceChannel);
        else if (!this.connection) throw new Error('Not connected to voice.');
        resource = await this._resourceFromDownload(url);
      } else {
        const ytdlpBin = await getYtDlp();
        const playUrl = this.current.watchUrl || url;
        const needArt =
          !this.current.artwork || isYoutubeClipThumb(this.current.artwork);
        const tasks = [];
        if (voiceChannel) tasks.push(this.ensureConnection(voiceChannel));
        if (needArt) {
          tasks.push(
            enrichTrackFromCatalog(this.current, { timeoutMs: 400 }).catch(() => this.current)
          );
        }
        if (this.current.fromStub || !realMeta(this.current.title) || !realMeta(this.current.artist)) {
          tasks.push(hydrateYoutubeMeta(this.current, 800).catch(() => this.current));
        }
        await Promise.all(tasks);
        if (isYoutubeClipThumb(this.current.artwork)) this.current.artwork = null;
        resource = await createPipedYtDlpResource(playUrl, this, ytdlpBin);
      }
    } catch (err) {
      console.error('[music] failed to create audio resource:', err);
      this.current = null;
      throw err;
    }

    if (resource.volume) {
      const vol = this.volume <= 0 ? 0 : Math.max(0.01, this.volume / 100);
      resource.volume.setVolume(vol);
    }

    this._ignoreIdle = true;
    this._idleArmed = false;
    this._playGen += 1;
    this.player.play(resource);
    try {
      await entersState(this.player, AudioPlayerStatus.Playing, 20_000);
      console.log('[music] player reached Playing');
      this._ignoreIdle = false;
    } catch (err) {
      const ffErr = resource._ffmpegStderr?.() || '';
      console.error('[music] never reached Playing:', err.message, ffErr.slice(0, 200));
      this._ignoreIdle = false;
      throw err;
    }
  }

  async _resourceFromDownload(watchUrl) {
    const dir = getTempDir();
    const outTemplate = path.join(dir, `${this.guildId}-${Date.now()}.%(ext)s`);
    const bin = await getYtDlp();

    await runYtDlp(bin, [
      '-f',
      'bestaudio/best/18',
      '-o',
      outTemplate,
      '--no-playlist',
      '--no-warnings',
      ...youtubeCompatArgs(),
      watchUrl,
    ]);

    const files = fs.readdirSync(dir)
      .filter((f) => f.startsWith(`${this.guildId}-`))
      .map((f) => path.join(dir, f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

    if (!files.length) throw new Error('yt-dlp download produced no file');
    this.tempFile = files[0];
    console.log('[music] downloaded', this.tempFile);
    return createFfmpegPcmResource(this.tempFile, this);
  }

  async _playNext() {
    if (this._playNextLock) return;
    this._playNextLock = true;
    this._ignoreIdle = true;
    try {
      while (this.queue.length) {
        this.current = this.queue.shift();
        try {
          await this._startCurrent(null);
          this._prefetchNext();
          return;
        } catch (err) {
          console.error('[music] failed next track:', err.message);
          this.current = null;
        }
      }
      this.current = null;
      try {
        this.player.stop(true);
      } catch (_) {}
    } finally {
      this._playNextLock = false;
    }
  }

  resetControlVotes() {
    this.skipVotes = new Set();
    this.stopVotes = new Set();
  }

  skip() {
    const skipped = this.current;
    const next = this.queue[0] || null;
    this.resetControlVotes();
    this._ignoreIdle = true;
    this._idleArmed = false;
    this._cleanupTemp();
    this._killChild();
    this._playNext().catch((err) => console.error('[music] skip playNext:', err.message));
    return { skipped, next };
  }

  pause() {
    if (this.player.state.status !== AudioPlayerStatus.Playing) return false;
    const ok = this.player.pause(true);
    if (ok) {
      this.paused = true;
      this.pausedAt = Date.now();
    }
    return ok;
  }

  resume() {
    if (this.player.state.status !== AudioPlayerStatus.Paused) return false;
    const ok = this.player.unpause();
    if (ok) {
      if (this.pausedAt) this.accumulatedPauseMs += Date.now() - this.pausedAt;
      this.paused = false;
      this.pausedAt = null;
    }
    return ok;
  }

  setVolume(vol) {
    this.volume = Math.max(0, Math.min(100, vol));
    const resource = this.player.state.resource;
    if (resource?.volume) {
      resource.volume.setVolume(this.volume <= 0 ? 0 : Math.max(0.01, this.volume / 100));
    }
    return this.volume;
  }

  stop() {
    this.queue = [];
    this.current = null;
    this.resetControlVotes();
    this._ignoreIdle = true;
    this.player.stop(true);
    this._cleanupTemp();
    this._killChild();
    try {
      this.connection?.destroy();
    } catch (_) {}
    this.connection = null;
    this._ignoreIdle = false;
    guildPlayers.delete(this.guildId);
  }

  _killChild() {
    if (this._ytdlpChild) {
      try {
        this._ytdlpChild.kill('SIGKILL');
      } catch (_) {}
      this._ytdlpChild = null;
    }
    if (this._opusChild) {
      try {
        this._opusChild.kill('SIGKILL');
      } catch (_) {}
      this._opusChild = null;
    }
    if (this._child) {
      try {
        this._child.kill('SIGKILL');
      } catch (_) {}
      this._child = null;
    }
  }

  _cleanupTemp() {
    if (this.tempFile && fs.existsSync(this.tempFile)) {
      try {
        fs.unlinkSync(this.tempFile);
      } catch (_) {}
    }
    this.tempFile = null;
  }
}

function getGuildMusic(guildId) {
  let g = guildPlayers.get(guildId);
  if (!g) {
    g = new GuildMusic(guildId);
    guildPlayers.set(guildId, g);
  }
  return g;
}

function maybeLeaveIfEmpty(guild, channelId) {
  if (!channelId) return;
  const music = guildPlayers.get(guild.id);
  if (!music?.connection) return;
  if (music.connection.joinConfig.channelId !== channelId) return;

  const channel = guild.channels.cache.get(channelId);
  if (!channel || !channel.isVoiceBased()) return;

  const humans = channel.members.filter((m) => !m.user.bot);
  if (humans.size === 0) {
    console.log(`[music] leaving ${channel.name} — no humans left`);
    music.stop();
  }
}



module.exports = {
  getGuildMusic,
  maybeLeaveIfEmpty,
  guildPlayers,
  getFfmpegPath,
  ensureFfmpeg,
  getTempDir,
  getYtDlp,
  getDirectAudioUrl,
  getStreamAndMeta,
  prefetchStream,
  extractVideoId,
  runYtDlp,
  youtubeCompatArgs,
  updateYtDlp,
  BIN_DIR,
  DEFAULTS,
  getGuildSettings,
  setGuildSetting,
  PLAYBACK_MODE_LABELS,
  LINK_RESOLUTION_LABELS,
  COLORS,
  bt,
  mdLink,
  isYoutubeClipThumb,
  extractYoutubeVideoId,
  youtubeThumbUrl,
  displayArtwork,
  realMeta,
  searchCatalog,
  fetchAlbumArtFast,
  enrichTrackFromCatalog,
  safeAlbumArt,
};
