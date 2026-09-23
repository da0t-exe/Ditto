import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { tr, type Lang } from '../../core/i18n.js';
import { COLOR } from '../../core/ui.js';
import type { GuildMusic, LoopMode, Track } from './player.js';
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
const escape = (s: string) => s.replace(/([\\*_`~|[\]])/g, '\\$1');

export function trackLine(t: Track) {
  const who = t.author ? ` — ${escape(cut(t.author, 40))}` : '';
  return `[${escape(cut(t.title, 70))}](${t.link})${who}`;
}

function progressBar(position: number, duration: number | null) {
  if (!duration) return '';
  const slots = 18;
  const at = Math.min(slots - 1, Math.floor((position / duration) * slots));
  return `${'▬'.repeat(at)}🔘${'▬'.repeat(slots - 1 - at)}`;
}

const LOOP_LABEL: Record<LoopMode, [string, string]> = {
  off: ['Loop off', 'Boucle désactivée'],
  track: ['Looping this track', 'Boucle sur ce titre'],
  queue: ['Looping the queue', 'Boucle sur la file'],
};

export function nowPlayingEmbed(music: GuildMusic, lang: Lang) {
  const t = music.current;
  if (!t) return new EmbedBuilder().setColor(COLOR.neutral).setDescription(tr(lang, '⏹️ Nothing is playing.', '⏹️ Rien en lecture.'));
  const position = music.position;
  const time = t.live ? '🔴 LIVE' : `\`${formatTime(position)} / ${formatTime(t.duration)}\``;
  const lines = [
    `### ${trackLine(t)}`,
    t.live ? time : `${progressBar(position, t.duration)}\n${time}`,
    `${tr(lang, 'Requested by', 'Demandé par')} <@${t.requesterId}> · ${SOURCE_LABEL[t.source]}`,
  ];
  const e = new EmbedBuilder()
    .setColor(music.paused ? COLOR.warn : COLOR.primary)
    .setAuthor({ name: music.paused ? tr(lang, '⏸️ Paused', '⏸️ En pause') : tr(lang, '🎶 Now playing', '🎶 En cours de lecture') })
    .setDescription(lines.join('\n'))
    .setFooter({
      text: [
        `${tr(lang, 'Volume', 'Volume')} ${music.volume}%`,
        tr(lang, ...LOOP_LABEL[music.loop]),
        music.filter !== 'none' ? `🎛️ ${music.filter}` : null,
        tr(lang, `${music.queue.length} in queue`, `${music.queue.length} en file`),
      ]
        .filter(Boolean)
        .join(' · '),
    });
  if (t.thumbnail) e.setThumbnail(t.thumbnail);
  return e;
}

export function controls(music: GuildMusic, lang: Lang) {
  const loopEmoji = music.loop === 'track' ? '🔂' : '🔁';
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('music:pause')
        .setEmoji(music.paused ? '▶️' : '⏸️')
        .setStyle(music.paused ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('music:skip').setEmoji('⏭️').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('music:stop').setEmoji('⏹️').setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId('music:loop')
        .setEmoji(loopEmoji)
        .setStyle(music.loop === 'off' ? ButtonStyle.Secondary : ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('music:queue').setEmoji('📜').setLabel(tr(lang, 'Queue', 'File')).setStyle(ButtonStyle.Secondary)
    ),
  ];
}

export function queueEmbed(music: GuildMusic, lang: Lang, page: number) {
  const perPage = 10;
  const pages = Math.max(1, Math.ceil(music.queue.length / perPage));
  const p = Math.min(Math.max(1, page), pages);
  const slice = music.queue.slice((p - 1) * perPage, p * perPage);
  const total = music.queue.reduce((s, t) => s + (t.duration ?? 0), 0);
  const lines = slice.map((t, k) => `\`${(p - 1) * perPage + k + 1}.\` ${trackLine(t)} \`${formatTime(t.duration)}\``);
  const head = music.current ? `**${tr(lang, 'Now:', 'Maintenant :')}** ${trackLine(music.current)}\n\n` : '';
  return new EmbedBuilder()
    .setColor(COLOR.primary)
    .setTitle(tr(lang, '📜 Queue', "📜 File d'attente"))
    .setDescription(head + (lines.join('\n') || tr(lang, 'The queue is empty.', 'La file est vide.')))
    .setFooter({
      text: `${tr(lang, 'Page', 'Page')} ${p}/${pages} · ${tr(lang, `${music.queue.length} tracks`, `${music.queue.length} titres`)} · ${formatTime(total)}`,
    });
}
