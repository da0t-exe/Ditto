/**
 * Runs Lavalink inside Ditto: no second server, no custom egg.
 *
 * On first start it fetches a Java runtime (unless one is installed) and the latest
 * Lavalink release into data/lavalink, writes its config, and starts it on
 * 127.0.0.1. Once a day it looks for new Lavalink and YouTube plugin releases and
 * restarts onto them as soon as nobody is listening.
 *
 * Set LAVALINK_HOST (and LAVALINK_PORT, LAVALINK_PASSWORD) to use an external node instead.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { env } from '../../env.js';
import { log } from '../../core/log.js';

export interface NodeConfig {
  host: string;
  port: number;
  password: string;
  secure: boolean;
}

const DIR = path.join(env.dataDir, 'lavalink');
const JRE_DIR = path.join(DIR, 'jre');
const JAR = path.join(DIR, 'Lavalink.jar');
const VERSIONS = path.join(DIR, 'versions.json');
const PORT = Number(process.env.LAVALINK_PORT ?? 2333);
const MEMORY = process.env.LAVALINK_MEMORY ?? '512M';
const GITHUB = 'https://api.github.com/repos';
/** Auto-updates stay on this major version: a new major could break lavalink-client. */
const LAVALINK_MAJOR = 4;

interface Versions {
  lavalink?: string;
  youtube?: string;
}

const readVersions = (): Versions => {
  try {
    return JSON.parse(fs.readFileSync(VERSIONS, 'utf8')) as Versions;
  } catch {
    return {};
  }
};

interface Release {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: { name: string; browser_download_url: string }[];
}

async function github<T>(route: string): Promise<T> {
  const res = await fetch(`${GITHUB}/${route}`, {
    headers: { 'User-Agent': 'Ditto (https://github.com/da0t-exe/Ditto)', Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`${route}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

const latestRelease = (repo: string) => github<Release>(`${repo}/releases/latest`);

/** Newest stable Lavalink of the pinned major version. */
async function latestLavalink(): Promise<Release> {
  const releases = await github<Release[]>('lavalink-devs/Lavalink/releases?per_page=50');
  const match = releases.find((r) => !r.draft && !r.prerelease && r.tag_name.startsWith(`${LAVALINK_MAJOR}.`));
  if (!match) throw new Error(`no Lavalink ${LAVALINK_MAJOR}.x release found`);
  return match;
}

async function download(url: string, dest: string) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`);
  const tmp = `${dest}.part`;
  await pipeline(Readable.fromWeb(res.body as never), fs.createWriteStream(tmp));
  fs.renameSync(tmp, dest);
}

// ---------- Java ----------

function javaVersion(bin: string) {
  const out = spawnSync(bin, ['-version'], { encoding: 'utf8', timeout: 20_000 });
  const text = `${out.stderr ?? ''}${out.stdout ?? ''}`;
  const m = /version "(\d+)/.exec(text);
  return out.status === 0 && m ? Number(m[1]) : 0;
}

function findJava(dir: string): string | null {
  if (!fs.existsSync(dir)) return null;
  const exe = process.platform === 'win32' ? 'java.exe' : 'java';
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const candidate = path.join(full, process.platform === 'darwin' ? 'Contents/Home/bin' : 'bin', exe);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

const isMusl = () => {
  if (process.platform !== 'linux') return false;
  const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined;
  return !report?.header?.glibcVersionRuntime;
};

/** Java 17+ from the system, or a Temurin 21 JRE fetched from Adoptium. */
async function ensureJava() {
  if (javaVersion('java') >= 17) return 'java';
  const local = findJava(JRE_DIR);
  if (local && javaVersion(local) >= 17) return local;

  const os = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : isMusl() ? 'alpine-linux' : 'linux';
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x64';
  log.info('music', `downloading a Java 21 runtime (${os}/${arch})…`);
  fs.rmSync(JRE_DIR, { recursive: true, force: true });
  fs.mkdirSync(JRE_DIR, { recursive: true });
  const archive = path.join(JRE_DIR, os === 'windows' ? 'jre.zip' : 'jre.tar.gz');
  await download(`https://api.adoptium.net/v3/binary/latest/21/ga/${os}/${arch}/jre/hotspot/normal/eclipse`, archive);
  const untar = spawnSync('tar', [os === 'windows' ? '-xf' : '-xzf', archive, '-C', JRE_DIR], { encoding: 'utf8' });
  fs.rmSync(archive, { force: true });
  if (untar.status !== 0) throw new Error(`could not unpack Java: ${untar.stderr}`);
  const java = findJava(JRE_DIR);
  if (!java) throw new Error('Java was downloaded but not found');
  return java;
}

// ---------- Lavalink jar and config ----------

/** Downloads the latest Lavalink and notes the latest YouTube plugin; returns true when something changed. */
async function fetchLatest(): Promise<boolean> {
  const current = readVersions();
  const next: Versions = { ...current };
  const lavalink = await latestLavalink();
  if (lavalink.tag_name !== current.lavalink || !fs.existsSync(JAR)) {
    const want = isMusl() ? 'Lavalink-musl.jar' : 'Lavalink.jar';
    const asset = lavalink.assets.find((a) => a.name === want) ?? lavalink.assets.find((a) => a.name === 'Lavalink.jar');
    if (!asset) throw new Error('no Lavalink.jar in the latest release');
    log.info('music', `downloading Lavalink ${lavalink.tag_name}…`);
    fs.mkdirSync(DIR, { recursive: true });
    await download(asset.browser_download_url, JAR);
    next.lavalink = lavalink.tag_name;
  }
  try {
    next.youtube = (await latestRelease('lavalink-devs/youtube-source')).tag_name;
  } catch (err) {
    log.warn('music', `youtube plugin version check failed: ${(err as Error).message}`);
  }
  const changed = next.lavalink !== current.lavalink || next.youtube !== current.youtube;
  if (changed) fs.writeFileSync(VERSIONS, JSON.stringify(next, null, 2));
  return changed;
}

function password() {
  if (process.env.LAVALINK_PASSWORD) return process.env.LAVALINK_PASSWORD;
  const file = path.join(DIR, 'password');
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(24).toString('hex'));
  return fs.readFileSync(file, 'utf8').trim();
}

function writeConfig(pass: string) {
  const { youtube } = readVersions();
  const plugin = youtube
    ? `  plugins:\n    - dependency: "dev.lavalink.youtube:youtube-plugin:${youtube}"\n      snapshot: false\n`
    : '';
  fs.writeFileSync(
    path.join(DIR, 'application.yml'),
    `# Written by Ditto on every start — edits are overwritten.
server:
  port: ${PORT}
  address: 127.0.0.1
lavalink:
${plugin}  server:
    password: "${pass}"
    sources:
      youtube: false
      bandcamp: true
      soundcloud: true
      twitch: true
      vimeo: true
      nico: false
      http: true
      local: true
    bufferDurationMs: 400
    frameBufferDurationMs: 5000
    opusEncodingQuality: 10
    resamplingQuality: HIGH
    trackStuckThresholdMs: 10000
    useSeekGhosting: true
    playerUpdateInterval: 2
    youtubeSearchEnabled: false
    soundcloudSearchEnabled: false
plugins:
  youtube:
    enabled: true
    allowSearch: true
    allowDirectVideoIds: true
    allowDirectPlaylistIds: true
    clients: ["MUSIC", "ANDROID_VR", "WEB", "WEBEMBEDDED"]
logging:
  level:
    root: WARN
    lavalink: INFO
`
  );
}

// ---------- Process ----------

let child: ChildProcess | null = null;
let stopping = false;
let restartPending = false;

async function waitReady(node: NodeConfig, timeoutMs = 90_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const res = await fetch(`http://${node.host}:${node.port}/version`, { headers: { Authorization: node.password } });
      if (res.ok) return (await res.text()).trim();
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('Lavalink did not start in time');
}

/**
 * Environment for Lavalink without the variables Spring Boot would read as its own
 * settings — Pterodactyl sets SERVER_PORT to the server's public port, for one.
 */
function lavalinkEnv() {
  const clean: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!/^(SERVER|SPRING|LAVALINK|LOGGING|PLUGINS|METRICS|SENTRY|MANAGEMENT)_/i.test(k)) clean[k] = v;
  }
  return clean;
}

function launch(java: string) {
  stopping = false;
  child = spawn(java, [`-Xmx${MEMORY}`, '-jar', JAR, `--server.port=${PORT}`, '--server.address=127.0.0.1'], {
    cwd: DIR,
    env: lavalinkEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const relay = (d: Buffer) => {
    for (const line of String(d).split('\n')) {
      if (/\b(WARN|ERROR)\b|Exception|Lavalink is ready/.test(line)) log.info('lavalink', line.replace(/^.*?(WARN|ERROR|INFO)\s+/, '$1 ').trim().slice(0, 300));
    }
  };
  child.stdout?.on('data', relay);
  child.stderr?.on('data', relay);
  child.on('exit', (code) => {
    child = null;
    if (stopping) return;
    log.warn('music', `Lavalink stopped (code ${code}), restarting in 5 s`);
    setTimeout(() => launch(java), 5000);
  });
}

function stop() {
  stopping = true;
  child?.kill();
}

process.on('exit', () => child?.kill());

/**
 * Starts (or points at) a Lavalink node. `isIdle` tells whether a restart for an
 * update would interrupt someone.
 */
export async function startLavalink(isIdle: () => boolean): Promise<NodeConfig> {
  if (process.env.LAVALINK_HOST) {
    return {
      host: process.env.LAVALINK_HOST,
      port: PORT,
      password: process.env.LAVALINK_PASSWORD ?? 'youshallnotpass',
      secure: process.env.LAVALINK_SECURE === 'true',
    };
  }

  fs.mkdirSync(DIR, { recursive: true });
  const java = await ensureJava();
  try {
    await fetchLatest();
  } catch (err) {
    if (!fs.existsSync(JAR)) throw err;
    log.warn('music', `update check failed, keeping the current Lavalink: ${(err as Error).message}`);
  }
  const node: NodeConfig = { host: '127.0.0.1', port: PORT, password: password(), secure: false };
  writeConfig(node.password);
  launch(java);
  const version = await waitReady(node).catch((err) => {
    stop();
    throw err;
  });
  const { youtube } = readVersions();
  log.info('music', `Lavalink ${version} ready${youtube ? ` (YouTube plugin ${youtube})` : ''}`);

  // Daily update check; the restart waits until nobody is listening.
  setInterval(async () => {
    try {
      if (await fetchLatest()) restartPending = true;
    } catch (err) {
      log.warn('music', `update check failed: ${(err as Error).message}`);
    }
  }, 24 * 3600_000).unref();
  setInterval(async () => {
    if (!restartPending || !isIdle()) return;
    restartPending = false;
    log.info('music', 'restarting Lavalink onto the new version…');
    writeConfig(node.password);
    stop();
    await new Promise((r) => setTimeout(r, 3000));
    launch(java);
    await waitReady(node).catch((err) => log.error('music', err.message));
  }, 5 * 60_000).unref();

  return node;
}
