import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Client } from 'discord.js';
import { log } from '../core/log.js';
import { env, ROOT } from '../env.js';
import { guildDetail, guildLive, guildOf, HttpError, me, musicAction, runAction, setConfig, unlock } from './api.js';
import { adminPassword, allowAttempt, loginWithLink, loginWithPassword, logout, sessionOf, type Session } from './auth.js';

/**
 * The web dashboard: a small HTTP server inside the bot, with a single page and a
 * JSON API. On Pterodactyl it listens on the server's own port (SERVER_PORT).
 */
const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'public');
const STATIC: Record<string, { file: string; type: string }> = {
  '/': { file: path.join(PUBLIC, 'index.html'), type: 'text/html; charset=utf-8' },
  '/app.js': { file: path.join(PUBLIC, 'app.js'), type: 'text/javascript; charset=utf-8' },
  '/style.css': { file: path.join(PUBLIC, 'style.css'), type: 'text/css; charset=utf-8' },
  '/ditto.png': { file: path.join(ROOT, 'assets', 'ditto.png'), type: 'image/png' },
};

const FRAME_ANCESTORS = process.env.DASHBOARD_FRAME_ANCESTORS?.trim() || "'self'";
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': [
    "default-src 'self'",
    "img-src 'self' data: https:",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
    "script-src 'self'",
    "connect-src 'self'",
    `frame-ancestors ${FRAME_ANCESTORS}`,
  ].join('; '),
};

function send(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new HttpError(413, 'Too large');
    chunks.push(chunk as Buffer);
  }
  if (!size) return {};
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return body && typeof body === 'object' ? body : {};
  } catch {
    throw new HttpError(400, 'Bad JSON');
  }
}

const bearer = (req: http.IncomingMessage) => /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? null;

function whoIs(client: Client, s: Session) {
  if (!s.userId) return 'Admin';
  return client.users.cache.get(s.userId)?.username ?? 'Staff';
}

async function route(client: Client, req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://dashboard');
  const method = req.method ?? 'GET';

  const file = STATIC[url.pathname];
  if (method === 'GET' && file) {
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': file.type, 'Cache-Control': 'no-cache' });
    fs.createReadStream(file.file).pipe(res);
    return;
  }
  if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'Not found' });

  const ip = req.socket.remoteAddress ?? '?';
  if (method === 'POST' && url.pathname === '/api/login') {
    if (!allowAttempt(ip)) throw new HttpError(429, 'Too many tries — wait a few minutes.');
    const body = await readBody(req);
    const token = loginWithPassword(String(body.password ?? ''));
    if (!token) throw new HttpError(401, 'Wrong password');
    return send(res, 200, { token });
  }
  if (method === 'POST' && url.pathname === '/api/login/link') {
    if (!allowAttempt(ip)) throw new HttpError(429, 'Too many tries — wait a few minutes.');
    const body = await readBody(req);
    const login = loginWithLink(String(body.code ?? ''));
    if (!login) throw new HttpError(401, 'This link has expired or was already used. Run /dashboard again.');
    return send(res, 200, { token: login.token });
  }

  const token = bearer(req);
  const session = sessionOf(token);
  if (!session || !token) throw new HttpError(401, 'Please log in');
  if (method === 'POST' && url.pathname === '/api/logout') {
    logout(token);
    return send(res, 200, { ok: true });
  }
  if (method === 'GET' && url.pathname === '/api/me') return send(res, 200, me(client, session));

  const m = /^\/api\/guilds\/(\d{15,21})(?:\/(.+))?$/.exec(url.pathname);
  if (!m) throw new HttpError(404, 'Not found');
  const guild = guildOf(client, session, m[1]);
  const rest = m[2] ?? '';
  const by = whoIs(client, session);

  if (method === 'GET' && rest === '') return send(res, 200, guildDetail(guild));
  if (method === 'GET' && rest === 'live') return send(res, 200, guildLive(guild));
  if (method === 'PATCH' && rest === 'config') {
    const body = await readBody(req);
    return send(res, 200, await setConfig(guild, String(body.field ?? ''), body.values, by));
  }
  let a = /^actions\/([a-z-]+)$/.exec(rest);
  if (method === 'POST' && a) return send(res, 200, await runAction(guild, a[1], by));
  a = /^music\/([a-z]+)$/.exec(rest);
  if (method === 'POST' && a) return send(res, 200, await musicAction(guild, a[1], await readBody(req), by, session.userId ?? client.user!.id));
  a = /^locks\/(\d{15,21})$/.exec(rest);
  if (method === 'DELETE' && a) return send(res, 200, unlock(guild, a[1], by));
  throw new HttpError(404, 'Not found');
}

/** Where people reach the dashboard, for the links Ditto sends. */
export function dashboardUrl() {
  if (env.dashboardUrl) return env.dashboardUrl;
  const ip = process.env.SERVER_IP?.trim();
  const host = ip && ip !== '0.0.0.0' ? ip : null;
  return host ? `http://${host}:${env.dashboardPort}` : null;
}

export function startDashboard(client: Client) {
  const server = http.createServer((req, res) => {
    route(client, req, res).catch((err) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) log.error('dashboard', err);
      if (!res.headersSent) send(res, status, { error: status === 500 ? 'Something went wrong' : (err as Error).message });
      else res.end();
    });
  });
  server.on('error', (err) => log.error('dashboard', `could not start on port ${env.dashboardPort}: ${err.message}`));
  server.listen(env.dashboardPort, env.dashboardHost, () => {
    const { password, generated } = adminPassword();
    const where = dashboardUrl() ?? `http://<this server's address>:${env.dashboardPort}`;
    log.info('dashboard', `open ${where}`);
    log.info(
      'dashboard',
      generated ? `admin password: ${password}  (set DASHBOARD_PASSWORD to choose your own)` : 'admin password: the one in DASHBOARD_PASSWORD'
    );
  });
  return server;
}
