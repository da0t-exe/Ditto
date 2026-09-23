import { EmbedBuilder, MessageFlags, type MessageComponentInteraction, type RepliableInteraction } from 'discord.js';

export type Replyable = RepliableInteraction | MessageComponentInteraction;

// Same hues as Discord's coloured circle emoji.
export const COLOR = {
  primary: 0x55acee,
  success: 0x78b159,
  warn: 0xfdcb58,
  danger: 0xdd2e44,
  neutral: 0x2b2d31,
} as const;

export function embed(color: number, description: string, title?: string) {
  const e = new EmbedBuilder().setColor(color).setDescription(description);
  if (title) e.setTitle(title);
  return e;
}

export const ok = (text: string) => embed(COLOR.success, `✅ ${text}`);

export async function replyError(i: Replyable, text: string) {
  const payload = { embeds: [embed(COLOR.danger, `❌ ${text}`)], flags: MessageFlags.Ephemeral as const };
  if (i.deferred || i.replied) await i.followUp(payload);
  else await i.reply(payload);
}

/** Splits a leading emoji off a role name: « 🔴 Red » → { emoji: '🔴', label: 'Red' }. */
export function splitEmoji(name: string) {
  const m = /^(\p{Extended_Pictographic}️?)\s*(.*)$/u.exec(name);
  return m ? { emoji: m[1], label: m[2] || name } : { emoji: null, label: name };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs fn over items with at most `concurrency` calls in flight. */
export async function pool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  });
  await Promise.all(workers);
}

/** « 30m », « 2h », « 1h30 », « 45 » (minutes) → milliseconds. */
export function parseDuration(input: string): number | null {
  const s = input.trim().toLowerCase().replace(/\s+/g, '');
  if (/^\d+$/.test(s)) return Number(s) * 60_000;
  const m = /^(?:(\d+)[dj])?(?:(\d+)h)?(?:(\d+)(?:m|min)?)?$/.exec(s);
  if (!m || !(m[1] || m[2] || m[3])) return null;
  const ms = (Number(m[1] ?? 0) * 24 * 60 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)) * 60_000;
  return ms > 0 ? ms : null;
}
