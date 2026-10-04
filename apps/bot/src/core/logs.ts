import type { Guild } from 'discord.js';
import { getConfig } from './config.js';
import { log } from './log.js';

// Lines are batched for a few seconds instead of one message per event.
const queues = new Map<string, string[]>();
const timers = new Map<string, NodeJS.Timeout>();
const FLUSH_MS = 4000;

/** Writes a line to the server's log channel. */
export function logTo(guild: Guild, text: string) {
  if (!getConfig(guild.id).logChannel) return;
  const time = `<t:${Math.floor(Date.now() / 1000)}:T>`;
  const q = queues.get(guild.id) ?? [];
  q.push(`${time} ${text}`);
  queues.set(guild.id, q);
  if (!timers.has(guild.id)) timers.set(guild.id, setTimeout(() => flush(guild), FLUSH_MS));
}

const MESSAGE_MAX = 1900;

/** Groups lines into messages Discord accepts (2000 characters); a line too long on its own is cut. */
export function chunkLines(lines: string[], max = MESSAGE_MAX) {
  const chunks: string[] = [];
  let cur = '';
  for (const line of lines) {
    const l = line.length > max ? `${line.slice(0, max - 1)}…` : line;
    if (cur && cur.length + l.length + 1 > max) {
      chunks.push(cur);
      cur = '';
    }
    cur += (cur ? '\n' : '') + l;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

async function flush(guild: Guild) {
  timers.delete(guild.id);
  const lines = queues.get(guild.id) ?? [];
  queues.delete(guild.id);
  const channel = guild.channels.cache.get(getConfig(guild.id).logChannel ?? '');
  if (!channel?.isTextBased() || !lines.length) return;

  for (const content of chunkLines(lines)) {
    await channel.send({ content, allowedMentions: { parse: [] } }).catch((err) => log.warn('logs', err.message));
  }
}
