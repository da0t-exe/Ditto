import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  SectionBuilder,
  SeparatorSpacingSize,
  StringSelectMenuBuilder,
} from 'discord.js';
import { COLOR, text } from '../../core/ui.js';
import type { FilterName, GuildMusic, LoopMode, Track } from './player.js';
import { SOURCE_LABEL } from './search.js';

export function formatTime(sec: number | null | undefined) {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return '—';
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const escape = (s: string) => s.replace(/([\\*_`~|[\]()<>#-])/g, '\\$1');

export function trackLine(t: Track) {
  const who = t.author ? ` — ${escape(cut(t.author, 40))}` : '';
  return `[${escape(cut(t.title, 70))}](${t.link})${who}`;
}

export const FILTERS: { value: FilterName; label: string; emoji: string }[] = [
  { value: 'none', label: 'No filter', emoji: '🎚️' },
  { value: 'bassboost', label: 'Bass boost', emoji: '🔊' },
  { value: 'nightcore', label: 'Nightcore', emoji: '⚡' },
  { value: 'vaporwave', label: 'Vaporwave', emoji: '🌴' },
  { value: '8d', label: '8D', emoji: '🎧' },
  { value: 'karaoke', label: 'Karaoke', emoji: '🎤' },
];

const LOOP_LABEL: Record<LoopMode, string> = { off: 'Loop off', track: 'Looping this track', queue: 'Looping the queue' };

/** `1:23 ━━━━━━●───────── 3:45` */
function progress(position: number, duration: number | null) {
  if (!duration) return `\`${formatTime(position)}\``;
  const slots = 22;
  const at = Math.min(slots - 1, Math.floor((position / duration) * slots));
  return `\`${formatTime(position)}\` ${'━'.repeat(at)}●${'─'.repeat(slots - 1 - at)} \`${formatTime(duration)}\``;
}

const total = (tracks: Track[]) => tracks.reduce((s, t) => s + (t.duration ?? 0), 0);

function buttons(music: GuildMusic): [ActionRowBuilder<ButtonBuilder>, ActionRowBuilder<ButtonBuilder>, ActionRowBuilder<StringSelectMenuBuilder>] {
  const button = (id: string, emoji: string, style = ButtonStyle.Secondary) =>
    new ButtonBuilder().setCustomId(`music:${id}`).setEmoji(emoji).setStyle(style);
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      button('prev', '⏮️'),
      button('pause', music.paused ? '▶️' : '⏸️', music.paused ? ButtonStyle.Success : ButtonStyle.Primary),
      button('skip', '⏭️'),
      button('stop', '⏹️', ButtonStyle.Danger),
      button('loop', music.loop === 'track' ? '🔂' : '🔁', music.loop === 'off' ? ButtonStyle.Secondary : ButtonStyle.Success)
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      button('voldown', '🔉').setDisabled(music.volume <= 0),
      button('volup', '🔊').setDisabled(music.volume >= 100),
      button('shuffle', '🔀').setDisabled(music.queue.length < 2),
      button('queue', '📜').setLabel('Queue'),
      button('lyrics', '📝').setLabel('Lyrics')
    ),
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('music:filter')
        .setPlaceholder('🎛️ Audio filter')
        .addOptions(FILTERS.map((f) => ({ label: f.label, value: f.value, emoji: f.emoji, default: f.value === music.filter })))
    ),
  ];
}

/** The player: cover, title, live progress, what comes next, and every control. */
export function playerView(music: GuildMusic) {
  const t = music.current;
  if (!t) return idleView('⏹️ Nothing is playing — use `/play` to start.');

  const status = music.paused ? '⏸️ PAUSED' : '🎶 NOW PLAYING';
  const head = [`-# ${status} · ${SOURCE_LABEL[t.source]}`, `### ${trackLine(t)}`, t.live ? '🔴 **LIVE**' : progress(music.position, t.duration)];
  const container = new ContainerBuilder().setAccentColor(music.paused ? COLOR.warn : COLOR.primary);
  if (t.thumbnail) {
    container.addSectionComponents(
      new SectionBuilder().addTextDisplayComponents(...head.map(text)).setThumbnailAccessory((th) => th.setURL(t.thumbnail!))
    );
  } else container.addTextDisplayComponents(text(head.join('\n')));

  const filter = FILTERS.find((f) => f.value === music.filter);
  const details = [
    `Requested by <@${t.requesterId}>`,
    `🔊 ${music.volume}%`,
    LOOP_LABEL[music.loop],
    music.filter !== 'none' && filter ? `${filter.emoji} ${filter.label}` : null,
    music.queue.length ? `${music.queue.length} in queue · ${formatTime(total(music.queue))}` : 'Queue empty',
  ].filter(Boolean);
  container
    .addSeparatorComponents((s) => s.setDivider(true).setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents(text(`-# ${details.join(' · ')}`));
  const next = music.queue[0];
  if (next) container.addTextDisplayComponents(text(`**Up next** · ${trackLine(next)}`));
  const [playback, extras, filters] = buttons(music);
  container.addActionRowComponents(playback, extras).addActionRowComponents(filters);
  return { components: [container] };
}

export function idleView(message: string) {
  return {
    components: [new ContainerBuilder().setAccentColor(COLOR.neutral).addTextDisplayComponents(text(message))],
  };
}

export function queueView(music: GuildMusic, page: number) {
  const perPage = 10;
  const pages = Math.max(1, Math.ceil(music.queue.length / perPage));
  const p = Math.min(Math.max(1, page), pages);
  const slice = music.queue.slice((p - 1) * perPage, p * perPage);
  const lines = slice.map((t, k) => `\`${(p - 1) * perPage + k + 1}.\` ${trackLine(t)} · \`${formatTime(t.duration)}\``);
  const container = new ContainerBuilder()
    .setAccentColor(COLOR.primary)
    .addTextDisplayComponents(
      text(`## 📜 Queue${music.current ? `\n**Now** · ${trackLine(music.current)}` : ''}`),
      text(lines.join('\n') || 'The queue is empty.'),
      text(`-# Page ${p}/${pages} · ${music.queue.length} tracks · ${formatTime(total(music.queue))}`)
    );
  if (pages > 1) {
    container.addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`music:qpage:${p - 1}`)
          .setEmoji('◀️')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(p <= 1),
        new ButtonBuilder()
          .setCustomId(`music:qpage:${p + 1}`)
          .setEmoji('▶️')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(p >= pages)
      )
    );
  }
  return { components: [container] };
}
