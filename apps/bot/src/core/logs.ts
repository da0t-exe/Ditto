import type { Guild } from 'discord.js';
import { getConfig } from './config.js';
import { log } from './log.js';

// Les lignes sont regroupées quelques secondes pour éviter un message par événement.
const queues = new Map<string, string[]>();
const timers = new Map<string, NodeJS.Timeout>();
const FLUSH_MS = 4000;

export function logTo(guild: Guild, line: string) {
  if (!getConfig(guild.id).logChannel) return;
  const time = `<t:${Math.floor(Date.now() / 1000)}:T>`;
  const q = queues.get(guild.id) ?? [];
  q.push(`${time} ${line}`);
  queues.set(guild.id, q);
  if (!timers.has(guild.id)) timers.set(guild.id, setTimeout(() => flush(guild), FLUSH_MS));
}

async function flush(guild: Guild) {
  timers.delete(guild.id);
  const lines = queues.get(guild.id) ?? [];
  queues.delete(guild.id);
  const channel = guild.channels.cache.get(getConfig(guild.id).logChannel ?? '');
  if (!channel?.isTextBased() || !lines.length) return;

  const chunks: string[] = [];
  let cur = '';
  for (const l of lines) {
    if (cur.length + l.length + 1 > 1900) {
      chunks.push(cur);
      cur = '';
    }
    cur += (cur ? '\n' : '') + l;
  }
  if (cur) chunks.push(cur);

  for (const content of chunks) {
    await channel.send({ content, allowedMentions: { parse: [] } }).catch((err) => log.warn('logs', err.message));
  }
}
