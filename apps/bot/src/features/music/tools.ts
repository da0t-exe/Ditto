import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import ffmpegStatic from 'ffmpeg-static';
import { env } from '../../env.js';
import { log } from '../../core/log.js';

/**
 * yt-dlp reads link metadata, finds direct audio addresses when Lavalink's YouTube
 * source fails, and fetches clips from sites Lavalink does not know. It is downloaded
 * into data/bin on first use and updated once a day, because YouTube changes often.
 */
const BIN_DIR = path.join(env.dataDir, 'bin');
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

const works = (bin: string) => spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 20_000 }).status === 0;

async function prepare() {
  if (!fs.existsSync(localPath()) || !works(localPath())) await download();
  const bin = localPath();
  if (!works(bin)) throw new Error('yt-dlp does not run on this machine');

  // Recent yt-dlp needs a JavaScript runtime for YouTube; Node is right here.
  const help = spawnSync(bin, ['--help'], { encoding: 'utf8', timeout: 20_000 }).stdout ?? '';
  extraArgs = help.includes('--js-runtimes') ? ['--js-runtimes', `node:${process.execPath}`] : [];
  ytdlp = bin;
  log.info('music', `yt-dlp ${spawnSync(bin, ['--version'], { encoding: 'utf8' }).stdout.trim()} ready`);

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

/** Runs yt-dlp and returns its stdout. */
export async function runYtDlp(args: string[], timeoutMs = 25_000): Promise<string> {
  const bin = await ensureYtDlp();
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [...extraArgs, '--no-warnings', ...args], { windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(err.trim().split('\n').pop() || `yt-dlp exited with ${code}`));
    });
  });
}

const CACHE_DIR = path.join(env.dataDir, 'cache', 'audio');

/** The direct media address of a page (YouTube fallback: Lavalink streams it over HTTP from the same host). */
export async function directAudioUrl(url: string): Promise<string> {
  const out = await runYtDlp(['-g', '--no-playlist', '-f', 'bestaudio/best', url]);
  const first = out.split('\n').find((l) => l.startsWith('http'));
  if (!first) throw new Error('no audio address');
  return first.trim();
}

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
