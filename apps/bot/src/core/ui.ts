import {
  ContainerBuilder,
  EmbedBuilder,
  MessageFlags,
  SeparatorSpacingSize,
  TextDisplayBuilder,
  type MessageComponentInteraction,
  type RepliableInteraction,
} from 'discord.js';

export type Replyable = RepliableInteraction | MessageComponentInteraction;

// Same hues as Discord's coloured circle emoji; primary is reCAPTCHA's blue.
export const COLOR = {
  primary: 0x4a90e2,
  success: 0x78b159,
  warn: 0xfdcb58,
  danger: 0xdd2e44,
  neutral: 0x2b2d31,
} as const;

/** Flag for messages laid out with components (containers, galleries, text) instead of embeds. */
export const V2 = MessageFlags.IsComponentsV2;

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

export const text = (content: string) => new TextDisplayBuilder().setContent(content);

/** A coloured card holding lines of text, with a thin line between blocks passed as separate strings. */
export function card(color: number, ...blocks: string[]) {
  const c = new ContainerBuilder().setAccentColor(color);
  blocks.forEach((b, k) => {
    if (k) c.addSeparatorComponents((s) => s.setDivider(true).setSpacing(SeparatorSpacingSize.Small));
    c.addTextDisplayComponents(text(b));
  });
  return c;
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

const MAX_DURATION = 365 * 24 * 3600_000;

/** « 30m », « 2h », « 1h30 », « 45 » (minutes) → milliseconds. Null for anything else, zero, or more than a year. */
export function parseDuration(input: string): number | null {
  const s = input.trim().toLowerCase().replace(/\s+/g, '');
  const m = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)(?:m|min)?)?$/.exec(s);
  if (!m || !(m[1] || m[2] || m[3])) return null;
  const ms = (Number(m[1] ?? 0) * 24 * 60 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)) * 60_000;
  return ms > 0 && ms <= MAX_DURATION ? ms : null;
}
