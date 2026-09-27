import {
  EmbedBuilder,
  Events,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildTextBasedChannel,
  type MessageComponentInteraction,
  type VoiceBasedChannel,
} from 'discord.js';
import { log } from '../../core/log.js';
import { canModerateVoice } from '../../core/perms.js';
import type { Command, Feature } from '../../core/types.js';
import { COLOR, embed, ok, replyError, V2 } from '../../core/ui.js';
import { initEngine, lavalink } from './engine.js';
import { cleanTitle, findLyrics } from './lyrics.js';
import { GuildMusic, warm, type FilterName, type LoopMode, type Track } from './player.js';
import { resolveInput, UserError } from './search.js';
import { ensureYtDlp, sweepAudioCache } from './tools.js';
import { FILTERS, formatTime, idleView, playerView, queueView, trackLine } from './views.js';

const MAX_PLAYLIST = 200;
/** How often the player message moves its progress bar. */
const REFRESH_MS = 10_000;
const players = new Map<string, GuildMusic>();

type Ctx = ChatInputCommandInteraction<'cached'> | MessageComponentInteraction<'cached'>;

// ---------- The player message ----------

/**
 * Shows the player in the music channel: the same message is edited while it is the
 * last one there; once other messages have pushed it up, it is posted again below them.
 */
async function showPlayer(music: GuildMusic) {
  const channel = music.guild.channels.cache.get(music.textChannelId ?? '') as GuildTextBasedChannel | undefined;
  if (!channel?.isTextBased()) return;
  const view = playerView(music);
  const current = music.nowPlaying;
  // Ditto does not receive chat messages, so it asks which message is the last one.
  const last = current ? await channel.messages.fetch({ limit: 1 }).catch(() => null) : null;
  if (current && last?.first()?.id === current.id) {
    const edited = await current.edit(view).catch(() => null);
    if (edited) return;
  }
  await current?.delete().catch(() => {});
  music.nowPlaying = await channel.send({ ...view, flags: V2, allowedMentions: { parse: [] } }).catch(() => null);
}

async function refreshPlayer(music: GuildMusic) {
  await music.nowPlaying?.edit(playerView(music)).catch((err) => {
    if (err?.code === 10008) music.nowPlaying = null; // deleted by someone: stop editing it
  });
}

async function closePlayer(music: GuildMusic, message: string) {
  await music.nowPlaying?.edit(idleView(message)).catch(() => {});
  music.nowPlaying = null;
}

function getOrCreate(guild: Guild) {
  let music = players.get(guild.id);
  if (!music || music.isDestroyed) {
    music = new GuildMusic(guild, {
      onTrackStart: (m) => void showPlayer(m),
      onQueueEnd: (m) => void closePlayer(m, '✅ Queue finished — use `/play` to add more.'),
      onError: (m, track, error) => {
        log.warn('music', `${guild.name}: ${track.title}: ${error.message}`);
        const channel = guild.channels.cache.get(m.textChannelId ?? '');
        if (!channel?.isTextBased()) return;
        const reason = error instanceof UserError ? error.message : error.message.slice(0, 200);
        channel.send({ embeds: [embed(COLOR.danger, `⚠️ Could not play ${trackLine(track)}\n${reason}`)] }).catch(() => {});
      },
      onDestroy: (m) => {
        if (players.get(guild.id) === m) players.delete(guild.id);
        void closePlayer(m, '👋 Left the voice channel.');
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
  if (!music || (!music.current && !music.queue.length)) {
    await replyError(i, 'Nothing is playing.');
    return null;
  }
  if (canModerateVoice(i.member) || i.member.voice.channelId === music.channelId) return music;
  await replyError(i, `Join <#${music.channelId}> to control the music.`);
  return null;
}

/**
 * Skip and stop: the person who queued the track, staff, or a small room act at once;
 * otherwise half of the listeners have to agree.
 */
async function vote(i: Ctx, music: GuildMusic, votes: Set<string>, act: () => void, kind: 'skip' | 'stop') {
  const listeners = humansIn(music);
  const direct = music.current?.requesterId === i.user.id || canModerateVoice(i.member) || listeners <= 2;
  if (!direct) votes.add(i.user.id);
  const needed = Math.ceil(listeners / 2);
  if (direct || votes.size >= needed) {
    act();
    return true;
  }
  await i.reply({ embeds: [embed(COLOR.warn, `🗳️ Vote to ${kind}: **${votes.size}/${needed}**`)] });
  return false;
}

// ---------- /play ----------

/** Starts or adds to the music in `channel`; shared with the dashboard. */
export async function playIn(
  guild: Guild,
  channel: VoiceBasedChannel,
  textChannelId: string | null,
  query: string,
  requesterId: string,
  next = false
) {
  lavalink(); // throws a readable error while music is still starting
  const music = getOrCreate(guild);
  if (textChannelId) music.textChannelId = textChannelId;
  // Join the voice channel while the search runs: both take a moment.
  const joining = music.connect(channel);
  joining.catch(() => {});
  const leaveIfIdle = async () => {
    if (music.current || music.queue.length) return;
    await joining.catch(() => {});
    music.destroy();
  };
  let tracks: Track[];
  let playlist: string | undefined;
  try {
    const result = await resolveInput(query);
    tracks = result.tracks.slice(0, MAX_PLAYLIST).map((t) => ({ ...t, requesterId }));
    playlist = result.playlist;
    if (!tracks.length) throw new UserError('Nothing found for that search.');
  } catch (err) {
    await leaveIfIdle(); // nothing to play: do not sit in the channel
    throw err;
  }
  warm(tracks[0]); // look up the stream while the voice connection finishes
  try {
    await joining;
  } catch {
    await leaveIfIdle();
    throw new UserError(`I could not join ${channel}.`);
  }
  const position = await music.enqueue(tracks, next);
  return { music, tracks, position, playlist };
}

const play: Command = {
  data: new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play a song, a link or a playlist')
    .addStringOption((o) =>
      o.setName('query').setDescription('Song name or link (YouTube, Spotify, SoundCloud, Deezer, TikTok…)').setRequired(true).setMaxLength(300)
    )
    .addBooleanOption((o) => o.setName('next').setDescription('Play it right after the current track')),

  async run(i) {
    const channel = i.member.voice.channel;
    if (!channel) return replyError(i, 'Join a voice channel first.');
    const existing = players.get(i.guildId);
    if (existing?.current && existing.channelId && existing.channelId !== channel.id && !canModerateVoice(i.member)) {
      return replyError(i, `I’m already playing in <#${existing.channelId}>.`);
    }

    await i.deferReply();
    try {
      const { tracks, position, playlist } = await playIn(
        i.guild,
        channel,
        i.channelId,
        i.options.getString('query', true),
        i.user.id,
        !!i.options.getBoolean('next')
      );
      if (playlist || tracks.length > 1) {
        return i.editReply({ embeds: [ok(`Added ${tracks.length} tracks${playlist ? ` from **${playlist}**` : ''}.`)] });
      }
      const t = tracks[0];
      return i.editReply({
        embeds: [embed(COLOR.primary, position === 0 ? `▶️ ${trackLine(t)}` : `➕ ${trackLine(t)} — position **#${position}**`)],
      });
    } catch (err) {
      if (!(err instanceof UserError)) log.warn('music', (err as Error).message);
      const message = err instanceof UserError ? err.message : 'Search failed, try again.';
      return i.editReply({ embeds: [embed(COLOR.danger, `❌ ${message}`)] });
    }
  },
};

// ---------- Other commands ----------

const simple = (
  name: string,
  description: string,
  act: (i: ChatInputCommandInteraction<'cached'>, music: GuildMusic) => Promise<unknown>
): Command => ({
  data: new SlashCommandBuilder().setName(name).setDescription(description),
  async run(i) {
    const music = await listenerOf(i);
    if (music) return act(i, music);
  },
});

const skip = simple('skip', 'Skip the current track', async (i, music) => {
  if (await vote(i, music, music.skipVotes, () => music.skip(), 'skip')) return i.reply({ embeds: [ok('Skipped.')] });
});

const previous = simple('previous', 'Play the previous track again', async (i, music) => {
  const went = await music.previous();
  return i.reply({ embeds: [ok(went === 'previous' ? 'Back to the previous track.' : 'Back to the start of the track.')] });
});

const stop = simple('stop', 'Stop the music and leave', async (i, music) => {
  if (await vote(i, music, music.stopVotes, () => music.destroy(), 'stop')) return i.reply({ embeds: [ok('Stopped.')] });
});

const pause = simple('pause', 'Pause the music', async (i, music) => {
  music.pause();
  void refreshPlayer(music);
  return i.reply({ embeds: [ok('Paused.')] });
});

const resume = simple('resume', 'Resume the music', async (i, music) => {
  music.resume();
  void refreshPlayer(music);
  return i.reply({ embeds: [ok('Resumed.')] });
});

const nowplaying: Command = {
  data: new SlashCommandBuilder().setName('nowplaying').setDescription('Show the player'),
  async run(i) {
    const music = players.get(i.guildId);
    if (!music?.current) return replyError(i, 'Nothing is playing.');
    music.textChannelId = i.channelId;
    await i.reply({ embeds: [ok('Here is the player.')], flags: MessageFlags.Ephemeral });
    // Posted as a normal message so it keeps updating.
    return showPlayer(music);
  },
};

const queue: Command = {
  data: new SlashCommandBuilder()
    .setName('queue')
    .setDescription('Show the queue')
    .addIntegerOption((o) => o.setName('page').setDescription('Page').setMinValue(1)),
  async run(i) {
    const music = players.get(i.guildId);
    if (!music?.current && !music?.queue.length) return replyError(i, 'The queue is empty.');
    return i.reply({ ...queueView(music, i.options.getInteger('page') ?? 1), flags: V2 | MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  },
};

const volume: Command = {
  data: new SlashCommandBuilder()
    .setName('volume')
    .setDescription('Set the volume')
    .addIntegerOption((o) => o.setName('level').setDescription('0 to 100').setMinValue(0).setMaxValue(100).setRequired(true)),
  async run(i) {
    const music = await listenerOf(i);
    if (!music) return;
    music.setVolume(i.options.getInteger('level', true));
    void refreshPlayer(music);
    return i.reply({ embeds: [ok(`Volume set to ${music.volume}%.`)] });
  },
};

const loop: Command = {
  data: new SlashCommandBuilder()
    .setName('loop')
    .setDescription('Loop the track or the queue')
    .addStringOption((o) =>
      o
        .setName('mode')
        .setDescription('Loop mode')
        .setRequired(true)
        .addChoices({ name: 'Off', value: 'off' }, { name: 'Track', value: 'track' }, { name: 'Queue', value: 'queue' })
    ),
  async run(i) {
    const music = await listenerOf(i);
    if (!music) return;
    music.loop = i.options.getString('mode', true) as LoopMode;
    void refreshPlayer(music);
    const label = { off: 'Loop off.', track: 'Looping this track.', queue: 'Looping the queue.' };
    return i.reply({ embeds: [ok(label[music.loop])] });
  },
};

const shuffle = simple('shuffle', 'Shuffle the queue', async (i, music) => {
  music.shuffle();
  void refreshPlayer(music);
  return i.reply({ embeds: [ok(`Shuffled ${music.queue.length} tracks.`)] });
});

const clear = simple('clear', 'Empty the queue', async (i, music) => {
  const n = music.queue.length;
  music.queue.length = 0;
  music.queueChanged();
  void refreshPlayer(music);
  return i.reply({ embeds: [ok(`Removed ${n} tracks from the queue.`)] });
});

const remove: Command = {
  data: new SlashCommandBuilder()
    .setName('remove')
    .setDescription('Remove a track from the queue')
    .addIntegerOption((o) => o.setName('position').setDescription('Position in /queue').setMinValue(1).setRequired(true)),
  async run(i) {
    const music = await listenerOf(i);
    if (!music) return;
    const pos = i.options.getInteger('position', true);
    if (pos > music.queue.length) return replyError(i, `There are only ${music.queue.length} tracks in the queue.`);
    const [t] = music.queue.splice(pos - 1, 1);
    music.queueChanged();
    void refreshPlayer(music);
    return i.reply({ embeds: [ok(`Removed ${trackLine(t)}.`)], allowedMentions: { parse: [] } });
  },
};

async function lyricsReply(i: Ctx, asked: string | null) {
  const current = players.get(i.guildId)?.current;
  if (!asked && !current) return replyError(i, 'Nothing is playing — give a song name.');
  await i.deferReply({ flags: i.isButton() ? MessageFlags.Ephemeral : undefined });
  const hit = await findLyrics(asked ?? current!.title, asked ? '' : current!.author).catch(() => null);
  if (!hit) return i.editReply({ embeds: [embed(COLOR.warn, `No lyrics found for **${asked ?? cleanTitle(current!.title)}**.`)] });
  const body = hit.instrumental ? '🎼 Instrumental' : hit.plainLyrics!;
  const e = new EmbedBuilder()
    .setColor(COLOR.primary)
    .setTitle(`📝 ${hit.trackName} — ${hit.artistName}`.slice(0, 256))
    .setDescription(body.length > 4000 ? `${body.slice(0, 3990)}\n…` : body)
    .setFooter({ text: 'LRCLIB' });
  return i.editReply({ embeds: [e] });
}

const lyrics: Command = {
  data: new SlashCommandBuilder()
    .setName('lyrics')
    .setDescription('Show the lyrics of the current track')
    .addStringOption((o) => o.setName('song').setDescription('Another song (default: the one playing)')),
  run: (i) => lyricsReply(i, i.options.getString('song')),
};

/** « 1:30 », « 1:02:03 » or « 90 » → seconds. */
function parseTime(input: string) {
  const t = input.trim();
  if (/^\d+$/.test(t)) return Number(t);
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(t);
  return m ? Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}

const seek: Command = {
  data: new SlashCommandBuilder()
    .setName('seek')
    .setDescription('Jump to a moment of the track')
    .addStringOption((o) => o.setName('time').setDescription('e.g. 1:30 or 90 (seconds)').setRequired(true)),
  async run(i) {
    const music = await listenerOf(i);
    if (!music) return;
    const at = parseTime(i.options.getString('time', true));
    const t = music.current;
    if (at === null) return replyError(i, 'Invalid time. Examples: `1:30`, `90`.');
    if (!t || t.live) return replyError(i, 'This track cannot be sought.');
    if (t.duration && at >= t.duration) return replyError(i, `The track is ${formatTime(t.duration)} long.`);
    await music.seek(at);
    void refreshPlayer(music);
    return i.reply({ embeds: [ok(`Jumped to ${formatTime(at)}.`)] });
  },
};

const filter: Command = {
  data: new SlashCommandBuilder()
    .setName('filter')
    .setDescription('Apply an audio filter')
    .addStringOption((o) =>
      o
        .setName('effect')
        .setDescription('Filter')
        .setRequired(true)
        .addChoices(...FILTERS.map((f) => ({ name: f.label, value: f.value })))
    ),
  async run(i) {
    const music = await listenerOf(i);
    if (!music) return;
    const choice = FILTERS.find((f) => f.value === i.options.getString('effect', true))!;
    await i.deferReply();
    await music.setFilter(choice.value);
    void refreshPlayer(music);
    return i.editReply({ embeds: [ok(choice.value === 'none' ? 'Filters removed.' : `Filter: ${choice.label}.`)] });
  },
};

// ---------- Player buttons ----------

async function onComponent(i: MessageComponentInteraction<'cached'>, [action, arg]: string[]) {
  if (action === 'qpage') {
    const music = players.get(i.guildId);
    if (!music) return i.update(idleView('The queue is empty.'));
    return i.update(queueView(music, Number(arg)));
  }
  const music = await listenerOf(i);
  if (!music) return;
  const redraw = () => i.update(playerView(music));

  switch (action) {
    case 'pause':
      if (music.paused) music.resume();
      else music.pause();
      return redraw();
    case 'loop': {
      const order: LoopMode[] = ['off', 'queue', 'track'];
      music.loop = order[(order.indexOf(music.loop) + 1) % order.length];
      return redraw();
    }
    case 'voldown':
    case 'volup':
      music.setVolume(music.volume + (action === 'volup' ? 10 : -10));
      return redraw();
    case 'shuffle':
      music.shuffle();
      return redraw();
    case 'prev':
      await i.deferUpdate();
      await music.previous();
      return refreshPlayer(music);
    case 'queue':
      return i.reply({ ...queueView(music, 1), flags: V2 | MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    case 'lyrics':
      return lyricsReply(i, null);
    case 'filter':
      if (!i.isStringSelectMenu()) return;
      await i.deferUpdate();
      await music.setFilter((i.values[0] ?? 'none') as FilterName);
      return refreshPlayer(music);
    case 'skip':
      if (await vote(i, music, music.skipVotes, () => music.skip(), 'skip')) return i.deferUpdate().catch(() => {});
      return;
    case 'stop':
      if (await vote(i, music, music.stopVotes, () => music.destroy(), 'stop')) return i.deferUpdate().catch(() => {});
      return;
  }
}

// ---------- For the dashboard ----------

export const musicOf = (guildId: string) => players.get(guildId) ?? null;
export { refreshPlayer };

// ---------- Feature ----------

export const musicFeature: Feature = {
  name: 'music',
  commands: [play, skip, previous, stop, pause, resume, nowplaying, queue, volume, loop, shuffle, remove, clear, seek, filter, lyrics],
  components: { music: onComponent },
  init(client) {
    initEngine(client, {
      isIdle: () => ![...players.values()].some((m) => m.current),
      onTrackEnd: (guildId, encoded) => players.get(guildId)?.onEnded(encoded),
      onTrackError: (guildId, encoded, message) => players.get(guildId)?.onFailed(encoded, message),
      onPlayerGone: (guildId) => players.get(guildId)?.destroy(true),
    });
    // Fetch yt-dlp now so the first link is quick; clean downloaded clips every hour.
    ensureYtDlp().catch((err) => log.warn('music', `yt-dlp not ready: ${err.message}`));
    setInterval(sweepAudioCache, 3600_000).unref();

    // The progress bar moves on its own.
    setInterval(() => {
      for (const music of players.values()) if (music.current && !music.paused) void refreshPlayer(music);
    }, REFRESH_MS).unref();

    // Leave when everyone else has left.
    client.on(Events.VoiceStateUpdate, (oldState, newState) => {
      const music = players.get(newState.guild.id);
      if (!music?.channelId) return;
      if (oldState.channelId === music.channelId || newState.channelId === music.channelId) music.checkEmpty(humansIn(music));
    });
  },
};
