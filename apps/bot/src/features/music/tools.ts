import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import ffmpegStatic from 'ffmpeg-static';
import { env } from '../../env.js';
import { log } from '../../core/log.js';

/**
 * yt-dlp reads link metadata, finds direct audio addresses for YouTube, and fetches
 * clips from sites Lavalink does not know. It is downloaded into data/bin on first
 * use and updated once a day, because YouTube changes often.
 *
 * Everything here runs in child processes without blocking: the bot never freezes
 * while yt-dlp starts, checks or updates.
 */
const BIN_DIR = path.join(env.dataDir, 'bin');
/** yt-dlp keeps YouTube's player code here, so it is not fetched again for every track. */
const YTDLP_CACHE = path.join(env.dataDir, 'cache', 'yt-dlp');
const RELEASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/';

function assetName() {
  if (process.platform === 'win32') return 'yt-dlp.exe';
  if (process.platform === 'darwin') return 'yt-dlp_macos';
  return process.arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux';
}

const localPath = () => path.join(BIN_DIR, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

let ytdlp: string | null = null;
let extraArgs: string[] = [];
let preparing: Promise<string> | null = null;

export const ffmpegPath = () => (ffmpegStatic as unknown as string | null) ?? 'ffmpeg';

/** Runs a program and resolves with its output, without blocking the bot. */
export function run(bin: string, args: string[], timeoutMs = 25_000): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}

async function download() {
  fs.mkdirSync(BIN_DIR, { recursive: true });
  log.info('music', `downloading yt-dlp (${assetName()})…`);
  const res = await fetch(RELEASE + assetName());
  if (!res.ok || !res.body) throw new Error(`yt-dlp download failed: HTTP ${res.status}`);
  const tmp = `${localPath()}.part`;
  await pipeline(Readable.fromWeb(res.body as never), fs.createWriteStream(tmp));
  fs.renameSync(tmp, localPath());
  if (process.platform !== 'win32') fs.chmodSync(localPath(), 0o755);
}

const version = async (bin: string) => {
  try {
    const r = await run(bin, ['--version'], 30_000);
    return r.code === 0 ? r.out.trim() : null;
  } catch {
    return null;
  }
};

async function prepare() {
  const bin = localPath();
  if (!fs.existsSync(bin) || !(await version(bin))) await download();
  const v = await version(bin);
  if (!v) throw new Error('yt-dlp does not run on this machine');

  // Recent yt-dlp needs a JavaScript runtime for YouTube; Node is right here.
  const help = (await run(bin, ['--help'], 30_000)).out;
  extraArgs = help.includes('--js-runtimes') ? ['--js-runtimes', `node:${process.execPath}`] : [];
  fs.mkdirSync(YTDLP_CACHE, { recursive: true });
  ytdlp = bin;
  log.info('music', `yt-dlp ${v} ready`);

  // Keep it fresh: update now in the background, then once a day.
  const update = () => spawn(bin, ['-U'], { stdio: 'ignore', windowsHide: true }).on('error', () => {});
  update();
  setInterval(update, 24 * 3600_000).unref();
  return bin;
}

export function ensureYtDlp() {
  if (ytdlp) return Promise.resolve(ytdlp);
  preparing ??= prepare().finally(() => (preparing = null));
  return preparing;
}

/** Runs yt-dlp and returns its output. */
export async function runYtDlp(args: string[], timeoutMs = 25_000): Promise<string> {
  const bin = await ensureYtDlp();
  const r = await run(
    bin,
    [...extraArgs, '--no-warnings', '--no-progress', '--cache-dir', YTDLP_CACHE, '--socket-timeout', '15', ...args],
    timeoutMs
  );
  if (r.code === 0) return r.out;
  throw new Error(r.err.trim().split('\n').pop() || `yt-dlp exited with ${r.code}`);
}

// ---------- Direct audio addresses, cached ----------
// Finding the address of a YouTube stream is the slow part of starting a track
// (a few seconds), so it is done ahead of time and kept until the address expires.

const direct = new Map<string, { url: Promise<string>; expires: number }>();

function expiryOf(url: string) {
  const e = Number(new URL(url).searchParams.get('expire'));
  // Leave a margin; addresses without an expiry are kept an hour.
  return e ? e * 1000 - 10 * 60_000 : Date.now() + 3600_000;
}

/** The direct media address of a page (Lavalink streams it over HTTP). */
export function directAudioUrl(page: string): Promise<string> {
  const hit = direct.get(page);
  if (hit && hit.expires > Date.now()) return hit.url;
  const url = (async () => {
    const out = await runYtDlp(['-g', '--no-playlist', '-f', 'bestaudio/best', page]);
    const first = out.split('\n').find((l) => l.startsWith('http'));
    if (!first) throw new Error('no audio address');
    return first.trim();
  })();
  const entry = { url, expires: Date.now() + 60_000 };
  direct.set(page, entry);
  url.then(
    (u) => (entry.expires = expiryOf(u)),
    () => direct.delete(page)
  );
  if (direct.size > 500) for (const [k, v] of direct) if (v.expires < Date.now()) direct.delete(k);
  return url;
}

/** Forgets an address that stopped working, so the next try asks yt-dlp again. */
export function forgetDirect(page: string) {
  direct.delete(page);
}

const CACHE_DIR = path.join(env.dataDir, 'cache', 'audio');

/**
 * Downloads the audio of a short clip (TikTok, X, Instagram…) that Lavalink cannot read
 * by itself; Lavalink then plays the local file. Returns the file path.
 */
export async function downloadAudio(url: string): Promise<string> {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const name = crypto.createHash('sha1').update(url).digest('hex').slice(0, 16);
  const out = await runYtDlp(
    [
      '--no-playlist',
      '-f',
      'bestaudio/best',
      '--max-filesize',
      '80M',
      '--ffmpeg-location',
      ffmpegPath(),
      '-o',
      path.join(CACHE_DIR, `${name}.%(ext)s`),
      '--print',
      'after_move:filepath',
      url,
    ],
    180_000
  );
  const file = out.trim().split('\n').pop()?.trim();
  if (!file || !fs.existsSync(file)) throw new Error('download failed');
  return file;
}

/** True for files yt-dlp downloaded for us: the only local files Lavalink may play. */
export function isCachedAudio(file: string) {
  const rel = path.relative(CACHE_DIR, path.resolve(file));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Removes downloaded clips older than an hour. */
export function sweepAudioCache() {
  if (!fs.existsSync(CACHE_DIR)) return;
  const limit = Date.now() - 3600_000;
  for (const f of fs.readdirSync(CACHE_DIR)) {
    const full = path.join(CACHE_DIR, f);
    try {
      if (fs.statSync(full).mtimeMs < limit) fs.rmSync(full, { force: true });
    } catch {
      /* in use or gone */
    }
  }
}
