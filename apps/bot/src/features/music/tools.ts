import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import ffmpegStatic from 'ffmpeg-static';
import { env } from '../../env.js';
import { log } from '../../core/log.js';

/**
 * yt-dlp reads every source (YouTube, SoundCloud, TikTok, Twitch…) and FFmpeg turns
 * it into raw audio for Discord. yt-dlp is downloaded into data/bin on first use and
 * updated once a day, because YouTube changes often.
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

export interface AudioStream {
  stream: Readable;
  kill(): void;
}

/** yt-dlp → FFmpeg → 48 kHz stereo PCM, ready for an inline-volume audio resource. */
export async function openStream(url: string): Promise<AudioStream> {
  const bin = await ensureYtDlp();
  const children: ChildProcess[] = [];
  const source = spawn(
    bin,
    [
      ...extraArgs,
      '--no-warnings',
      '--quiet',
      '--no-playlist',
      '--no-part',
      '-f',
      'bestaudio[acodec=opus]/bestaudio/best',
      '--ffmpeg-location',
      ffmpegPath(),
      '-o',
      '-',
      url,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
  );
  const ffmpeg = spawn(
    ffmpegPath(),
    ['-loglevel', 'error', '-i', 'pipe:0', '-vn', '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
  );
  children.push(source, ffmpeg);
  source.stdout.pipe(ffmpeg.stdin);
  // A closed pipe on skip is expected; anything else is logged.
  ffmpeg.stdin.on('error', () => {});
  source.stderr.on('data', (d) => {
    const line = String(d).trim();
    if (line && !/Broken pipe/i.test(line)) log.warn('music', `yt-dlp: ${line.split('\n').pop()}`);
  });
  source.on('error', (err) => log.warn('music', `yt-dlp: ${err.message}`));
  ffmpeg.on('error', (err) => log.warn('music', `ffmpeg: ${err.message}`));

  return {
    stream: ffmpeg.stdout,
    kill: () => {
      for (const c of children) if (c.exitCode === null) c.kill('SIGKILL');
    },
  };
}
