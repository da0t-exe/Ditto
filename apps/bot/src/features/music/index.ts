import {
  EmbedBuilder,
  Events,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Guild,
  type MessageComponentInteraction,
} from 'discord.js';
import { guildLang, loc, tr, userLang, type Lang } from '../../core/i18n.js';
import { log } from '../../core/log.js';
import { canModerateVoice } from '../../core/perms.js';
import type { Command, Feature } from '../../core/types.js';
import { COLOR, embed, ok, replyError } from '../../core/ui.js';
import { cleanTitle, findLyrics } from './lyrics.js';
import { GuildMusic, type LoopMode, type Track } from './player.js';
import { rememberPick, resolveInput, searchMusic, UserError } from './search.js';
import { ensureYtDlp } from './tools.js';
import { controls, formatTime, nowPlayingEmbed, queueEmbed, trackLine } from './views.js';

const MAX_PLAYLIST = 200;
const players = new Map<string, GuildMusic>();

type Ctx = ChatInputCommandInteraction<'cached'> | MessageComponentInteraction<'cached'>;

// ---------- Player lifecycle ----------

async function postNowPlaying(music: GuildMusic) {
  const channel = music.guild.channels.cache.get(music.textChannelId ?? '');
  if (!channel?.isTextBased()) return;
  const lang = guildLang(music.guild);
  await music.nowPlaying?.delete().catch(() => {});
  music.nowPlaying = await channel
    .send({ embeds: [nowPlayingEmbed(music, lang)], components: controls(music, lang), allowedMentions: { parse: [] } })
    .catch(() => null);
}

async function refreshNowPlaying(music: GuildMusic) {
  if (!music.nowPlaying) return;
  const lang = guildLang(music.guild);
  await music.nowPlaying.edit({ embeds: [nowPlayingEmbed(music, lang)], components: controls(music, lang) }).catch(() => {});
}

async function closeNowPlaying(music: GuildMusic, en: string, fr: string) {
  const lang = guildLang(music.guild);
  await music.nowPlaying?.edit({ embeds: [embed(COLOR.neutral, tr(lang, en, fr))], components: [] }).catch(() => {});
  music.nowPlaying = null;
}

function getOrCreate(guild: Guild) {
  let music = players.get(guild.id);
  if (!music) {
    music = new GuildMusic(guild, {
      onTrackStart: (m) => void postNowPlaying(m),
      onQueueEnd: (m) => void closeNowPlaying(m, '✅ Queue finished.', '✅ File terminée.'),
      onError: (m, track, error) => {
        log.warn('music', `${guild.name}: ${track.title}: ${error.message}`);
        const channel = guild.channels.cache.get(m.textChannelId ?? '');
        if (!channel?.isTextBased()) return;
        const lang = guildLang(guild);
        const reason = error instanceof UserError ? tr(lang, error.en, error.fr) : error.message.slice(0, 200);
        channel
          .send({ embeds: [embed(COLOR.danger, `⚠️ ${tr(lang, 'Could not play', 'Impossible de lire')} ${trackLine(track)}\n${reason}`)] })
          .catch(() => {});
      },
      onDestroy: (m) => {
        players.delete(guild.id);
        void closeNowPlaying(m, '👋 Left the voice channel.', '👋 J’ai quitté le salon vocal.');
      },
    });
    players.set(guild.id, music);
  }
  return music;
}

const humansIn = (music: GuildMusic) => {
  const channel = music.guild.channels.cache.get(music.channelId ?? '');
  return channel?.isVoiceBased() ? channel.members.filter((m) => !m.user.bot).size : 0;
};

// ---------- Guards ----------

/** The server's player, if this person may control it: same voice channel, or staff from anywhere. */
async function listenerOf(i: Ctx): Promise<GuildMusic | null> {
  const music = players.get(i.guildId);
  const lang = userLang(i);
  if (!music || (!music.current && !music.queue.length)) {
    await replyError(i, tr(lang, 'Nothing is playing.', 'Rien en lecture.'));
    return null;
  }
  if (canModerateVoice(i.member) || i.member.voice.channelId === music.channelId) return music;
  await replyError(i, tr(lang, `Join <#${music.channelId}> to control the music.`, `Rejoins <#${music.channelId}> pour contrôler la musique.`));
  return null;
}

/**
 * Skip and stop: the person who queued the track, staff, or a small room act at once;
 * otherwise half of the listeners have to agree.
 */
async function vote(i: Ctx, music: GuildMusic, votes: Set<string>, act: () => void, kind: 'skip' | 'stop') {
  const lang = userLang(i);
  const listeners = humansIn(music);
  const direct = music.current?.requesterId === i.user.id || canModerateVoice(i.member) || listeners <= 2;
  if (!direct) votes.add(i.user.id);
  const needed = Math.ceil(listeners / 2);
  if (direct || votes.size >= needed) {
    act();
    return true;
  }
  const what = kind === 'skip' ? tr(lang, 'skip', 'passer') : tr(lang, 'stop', 'arrêter');
  await i.reply({
    embeds: [embed(COLOR.warn, tr(lang, `🗳️ Vote to ${what}: **${votes.size}/${needed}**`, `🗳️ Vote pour ${what} : **${votes.size}/${needed}**`))],
  });
  return false;
}

// ---------- Commands ----------

const play: Command = {
  data: loc(new SlashCommandBuilder(), 'play', ['Play a song, a link or a playlist', 'Jouer un titre, un lien ou une playlist']).addStringOption(
    (o) =>
      loc(o, ['query', 'recherche'], ['Song name or link (YouTube, Spotify, SoundCloud, Deezer, TikTok…)', 'Nom du titre ou lien (YouTube, Spotify, SoundCloud, Deezer, TikTok…)'])
        .setRequired(true)
        .setAutocomplete(true)
  ),

  async autocomplete(i) {
    const q = i.options.getFocused().trim();
    if (q.length < 2 || /^https?:\/\//i.test(q)) return i.respond([]);
    try {
      const hits = await searchMusic(q, 6, 2200);
      return i.respond(
        hits.map((h) => {
          rememberPick(h);
          const name = `${h.title}${h.author ? ` — ${h.author}` : ''} (${formatTime(h.duration)})`;
          return { name: name.length > 100 ? `${name.slice(0, 99)}…` : name, value: `ytm:${new URL(h.url).searchParams.get('v')}` };
        })
      );
    } catch {
      return i.respond([]).catch(() => {});
    }
  },

  async run(i) {
    const lang = userLang(i);
    const channel = i.member.voice.channel;
    if (!channel) return replyError(i, tr(lang, 'Join a voice channel first.', 'Rejoins d’abord un salon vocal.'));
    const existing = players.get(i.guildId);
    if (existing?.current && existing.channelId && existing.channelId !== channel.id && !canModerateVoice(i.member)) {
      return replyError(i, tr(lang, `I’m already playing in <#${existing.channelId}>.`, `Je joue déjà dans <#${existing.channelId}>.`));
    }

    await i.deferReply();
    let result: Awaited<ReturnType<typeof resolveInput>>;
    try {
      result = await resolveInput(i.options.getString('query', true));
    } catch (err) {
      const text = err instanceof UserError ? tr(lang, err.en, err.fr) : tr(lang, 'Search failed, try again.', 'La recherche a échoué, réessaie.');
      if (!(err instanceof UserError)) log.warn('music', (err as Error).message);
      return i.editReply({ embeds: [embed(COLOR.danger, `❌ ${text}`)] });
    }

    const music = getOrCreate(i.guild);
    music.textChannelId = i.channelId;
    try {
      await music.connect(channel);
    } catch {
      if (!music.current) music.destroy();
      return i.editReply({ embeds: [embed(COLOR.danger, tr(lang, `❌ I could not join ${channel}.`, `❌ Je n’ai pas pu rejoindre ${channel}.`))] });
    }

    const tracks: Track[] = result.tracks.slice(0, MAX_PLAYLIST).map((t) => ({ ...t, requesterId: i.user.id }));
    const position = await music.enqueue(tracks);

    if (result.playlist || tracks.length > 1) {
      const name = result.playlist ? ` **${result.playlist}**` : '';
      return i.editReply({ embeds: [ok(tr(lang, `Added ${tracks.length} tracks from${name}.`, `${tracks.length} titres ajoutés depuis${name}.`))] });
    }
    const t = tracks[0];
    return i.editReply({
      embeds: [
        embed(
          COLOR.primary,
          position === 0
            ? `▶️ ${trackLine(t)}`
            : tr(lang, `➕ ${trackLine(t)} — position **#${position}**`, `➕ ${trackLine(t)} — position **n°${position}**`)
        ),
      ],
    });
  },
};

const simple = (
  name: string,
  desc: [string, string],
  act: (i: ChatInputCommandInteraction<'cached'>, music: GuildMusic, lang: Lang) => Promise<unknown>
): Command => ({
  data: loc(new SlashCommandBuilder(), name, desc),
  async run(i) {
    const music = await listenerOf(i);
    if (music) return act(i, music, userLang(i));
  },
});

const skip = simple('skip', ['Skip the current track', 'Passer le titre en cours'], async (i, music, lang) => {
  const done = await vote(i, music, music.skipVotes, () => music.skip(), 'skip');
  if (done) return i.reply({ embeds: [ok(tr(lang, 'Skipped.', 'Titre passé.'))] });
});

const stop = simple('stop', ['Stop the music and leave', 'Arrêter la musique et quitter'], async (i, music, lang) => {
  const done = await vote(i, music, music.stopVotes, () => music.destroy(), 'stop');
  if (done) return i.reply({ embeds: [ok(tr(lang, 'Stopped.', 'Musique arrêtée.'))] });
});

const pause = simple('pause', ['Pause the music', 'Mettre en pause'], async (i, music, lang) => {
  music.pause();
  void refreshNowPlaying(music);
  return i.reply({ embeds: [ok(tr(lang, 'Paused.', 'En pause.'))] });
});

const resume = simple('resume', ['Resume the music', 'Reprendre la lecture'], async (i, music, lang) => {
  music.resume();
  void refreshNowPlaying(music);
  return i.reply({ embeds: [ok(tr(lang, 'Resumed.', 'Lecture reprise.'))] });
});

const nowplaying: Command = {
  data: loc(new SlashCommandBuilder(), 'nowplaying', ['Show the current track', 'Afficher le titre en cours']),
  async run(i) {
    const music = players.get(i.guildId);
    const lang = userLang(i);
    if (!music?.current) return replyError(i, tr(lang, 'Nothing is playing.', 'Rien en lecture.'));
    return i.reply({ embeds: [nowPlayingEmbed(music, lang)], components: controls(music, lang), allowedMentions: { parse: [] } });
  },
};

const queue: Command = {
  data: loc(new SlashCommandBuilder(), 'queue', ['Show the queue', "Afficher la file d'attente"]).addIntegerOption((o) =>
    loc(o, 'page', ['Page', 'Page']).setMinValue(1)
  ),
  async run(i) {
    const music = players.get(i.guildId);
    const lang = userLang(i);
    if (!music?.current && !music?.queue.length) return replyError(i, tr(lang, 'The queue is empty.', 'La file est vide.'));
    return i.reply({ embeds: [queueEmbed(music, lang, i.options.getInteger('page') ?? 1)], allowedMentions: { parse: [] } });
  },
};

const volume: Command = {
  data: loc(new SlashCommandBuilder(), 'volume', ['Set the volume', 'Régler le volume']).addIntegerOption((o) =>
    loc(o, ['level', 'niveau'], ['0 to 100', '0 à 100']).setMinValue(0).setMaxValue(100).setRequired(true)
  ),
  async run(i) {
    const music = await listenerOf(i);
    if (!music) return;
    const level = i.options.getInteger('level', true);
    music.setVolume(level);
    void refreshNowPlaying(music);
    return i.reply({ embeds: [ok(tr(userLang(i), `Volume set to ${level}%.`, `Volume réglé à ${level} %.`))] });
  },
};

const loop: Command = {
  data: loc(new SlashCommandBuilder(), 'loop', ['Loop the track or the queue', 'Répéter le titre ou la file']).addStringOption((o) =>
    loc(o, ['mode', 'mode'], ['Loop mode', 'Mode de répétition'])
      .setRequired(true)
      .addChoices(
        { name: 'Off', name_localizations: { fr: 'Désactivé' }, value: 'off' },
        { name: 'Track', name_localizations: { fr: 'Titre' }, value: 'track' },
        { name: 'Queue', name_localizations: { fr: 'File' }, value: 'queue' }
      )
  ),
  async run(i) {
    const music = await listenerOf(i);
    if (!music) return;
    music.loop = i.options.getString('mode', true) as LoopMode;
    void refreshNowPlaying(music);
    const lang = userLang(i);
    const label = { off: tr(lang, 'Loop off.', 'Boucle désactivée.'), track: tr(lang, 'Looping this track.', 'Boucle sur ce titre.'), queue: tr(lang, 'Looping the queue.', 'Boucle sur la file.') };
    return i.reply({ embeds: [ok(label[music.loop])] });
  },
};

const shuffle = simple('shuffle', ['Shuffle the queue', 'Mélanger la file'], async (i, music, lang) => {
  music.shuffle();
  void refreshNowPlaying(music);
  return i.reply({ embeds: [ok(tr(lang, `Shuffled ${music.queue.length} tracks.`, `${music.queue.length} titres mélangés.`))] });
});

const clear = simple('clear', ['Empty the queue', 'Vider la file'], async (i, music, lang) => {
  const n = music.queue.length;
  music.queue.length = 0;
  void refreshNowPlaying(music);
  return i.reply({ embeds: [ok(tr(lang, `Removed ${n} tracks from the queue.`, `${n} titres retirés de la file.`))] });
});

const remove: Command = {
  data: loc(new SlashCommandBuilder(), 'remove', ['Remove a track from the queue', 'Retirer un titre de la file']).addIntegerOption((o) =>
    loc(o, 'position', ['Position in /queue', 'Position dans /queue']).setMinValue(1).setRequired(true)
  ),
  async run(i) {
    const music = await listenerOf(i);
    if (!music) return;
    const lang = userLang(i);
    const pos = i.options.getInteger('position', true);
    if (pos > music.queue.length) return replyError(i, tr(lang, `There are only ${music.queue.length} tracks in the queue.`, `Il n’y a que ${music.queue.length} titres dans la file.`));
    const [t] = music.queue.splice(pos - 1, 1);
    void refreshNowPlaying(music);
    return i.reply({ embeds: [ok(tr(lang, `Removed ${trackLine(t)}.`, `${trackLine(t)} retiré.`))], allowedMentions: { parse: [] } });
  },
};

const lyrics: Command = {
  data: loc(new SlashCommandBuilder(), 'lyrics', ['Show the lyrics of the current track', 'Afficher les paroles du titre en cours']).addStringOption((o) =>
    loc(o, ['song', 'titre'], ['Another song (default: the one playing)', 'Un autre titre (par défaut : celui en cours)'])
  ),
  async run(i) {
    const lang = userLang(i);
    const asked = i.options.getString('song');
    const current = players.get(i.guildId)?.current;
    if (!asked && !current) return replyError(i, tr(lang, 'Nothing is playing — give a song name.', 'Rien en lecture : indique un titre.'));
    await i.deferReply();
    const hit = await findLyrics(asked ?? current!.title, asked ? '' : current!.author).catch(() => null);
    if (!hit) {
      const what = asked ?? cleanTitle(current!.title);
      return i.editReply({ embeds: [embed(COLOR.warn, tr(lang, `No lyrics found for **${what}**.`, `Pas de paroles trouvées pour **${what}**.`))] });
    }
    const body = hit.instrumental ? tr(lang, '🎼 Instrumental', '🎼 Instrumental') : hit.plainLyrics!;
    const e = new EmbedBuilder()
      .setColor(COLOR.primary)
      .setTitle(`📝 ${hit.trackName} — ${hit.artistName}`.slice(0, 256))
      .setDescription(body.length > 4000 ? `${body.slice(0, 3990)}\n…` : body)
      .setFooter({ text: 'LRCLIB' });
    return i.editReply({ embeds: [e] });
  },
};

// ---------- Now-playing buttons ----------

async function onButton(i: MessageComponentInteraction<'cached'>, [action]: string[]) {
  const music = await listenerOf(i);
  if (!music) return;
  const lang = userLang(i);
  const refresh = () => i.update({ embeds: [nowPlayingEmbed(music, guildLang(i.guild))], components: controls(music, guildLang(i.guild)) });

  if (action === 'pause') {
    if (music.paused) music.resume();
    else music.pause();
    return refresh();
  }
  if (action === 'loop') {
    const order: LoopMode[] = ['off', 'queue', 'track'];
    music.loop = order[(order.indexOf(music.loop) + 1) % order.length];
    return refresh();
  }
  if (action === 'queue') {
    return i.reply({ embeds: [queueEmbed(music, lang, 1)], flags: MessageFlags.Ephemeral });
  }
  if (action === 'skip') {
    const done = await vote(i, music, music.skipVotes, () => music.skip(), 'skip');
    if (done) return i.deferUpdate().catch(() => {});
  }
  if (action === 'stop') {
    const done = await vote(i, music, music.stopVotes, () => music.destroy(), 'stop');
    if (done) return i.deferUpdate().catch(() => {});
  }
}

// ---------- Feature ----------

export const musicFeature: Feature = {
  name: 'music',
  commands: [play, skip, stop, pause, resume, nowplaying, queue, volume, loop, shuffle, remove, clear, lyrics],
  components: { music: onButton },
  init(client) {
    // Fetch yt-dlp now so the first /play is quick.
    ensureYtDlp().catch((err) => log.warn('music', `yt-dlp not ready: ${err.message}`));

    // Leave when everyone else has left.
    client.on(Events.VoiceStateUpdate, (oldState, newState) => {
      const music = players.get(newState.guild.id);
      if (!music?.channelId) return;
      if (oldState.channelId === music.channelId || newState.channelId === music.channelId) music.checkEmpty(humansIn(music));
    });
  },
};
