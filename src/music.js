const { generateDependencyReport } = require('@discordjs/voice');
const {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  PermissionsBitField,
  EmbedBuilder,
  MessageFlags,
} = require('discord.js');
const {
  getGuildMusic,
  maybeLeaveIfEmpty,
  getFfmpegPath,
  ensureFfmpeg,
  getYtDlp,
  updateYtDlp,
  getGuildSettings,
  setGuildSetting,
  PLAYBACK_MODE_LABELS,
  LINK_RESOLUTION_LABELS,
  COLORS,
  bt,
  mdLink,
  isYoutubeClipThumb,
  realMeta,
  displayArtwork,
} = require('./player');
const {
  resolvePlayInput,
  hydrateYoutubeMeta,
  resolveFirstPlaylistTrack,
  resolvePlaylistRest,
  MAX_PLAYLIST_TRACKS,
} = require('./resolve');

/**
 * Custom Discord emojis for YouTube / YouTube Music.
 * Upload server emojis named `youtube` and `youtubemusic`,
 * or set EMOJI_YOUTUBE / EMOJI_YOUTUBE_MUSIC in .env (e.g. <:youtube:ID>).
 */

let activeGuild = null;

const emojiFetching = new Set();

/**
 * Fire-and-forget: this used to be awaited in front of `deferReply()`, so a
 * slow emoji fetch delayed every single music command — and could burn the
 * interaction's 3s window outright.
 */
function setEmojiGuild(guild) {
  activeGuild = guild || null;
  if (!guild?.emojis || guild.emojis.cache.size > 0) return;
  if (emojiFetching.has(guild.id)) return;
  emojiFetching.add(guild.id);
  guild.emojis
    .fetch()
    .catch(() => {})
    .finally(() => emojiFetching.delete(guild.id));
}

function parseEmoji(value, fallbackName) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^<a?:[a-zA-Z0-9_]+:\d+>$/.test(raw)) return raw;
  if (/^\d{17,20}$/.test(raw)) return `<:${fallbackName}:${raw}>`;
  return '';
}

function findGuildEmoji(names) {
  const cache = activeGuild?.emojis?.cache;
  if (!cache) return '';
  const want = names.map((n) => n.toLowerCase());
  const found = cache.find((e) => want.includes(String(e.name || '').toLowerCase()));
  return found ? `${found}` : '';
}

function youtubeEmoji() {
  return findGuildEmoji(['youtube', 'yt']) || parseEmoji(process.env.EMOJI_YOUTUBE, 'youtube');
}

function youtubeMusicEmoji() {
  return (
    findGuildEmoji(['youtubemusic', 'youtube_music', 'ytmusic']) ||
    parseEmoji(process.env.EMOJI_YOUTUBE_MUSIC, 'youtubemusic')
  );
}

function sourceEmoji(trackOrPlatform) {
  const platform =
    typeof trackOrPlatform === 'string'
      ? trackOrPlatform
      : trackOrPlatform?.sourceKind || trackOrPlatform?.origin?.platform || '';
  const p = String(platform || '').toLowerCase().replace(/\s+/g, '');
  if (p.includes('youtubemusic')) return youtubeMusicEmoji();
  if (p.includes('youtube')) return youtubeEmoji();
  return '';
}

function withSourceEmoji(label, trackOrPlatform) {
  const em = sourceEmoji(trackOrPlatform);
  return em ? `${em} ${label}` : label;
}

function sourceLine(track) {
  const origin = track.origin || {};
  const playUrl = track.url;
  const kind = track.sourceKind;

  if (origin.platform && origin.platformUrl && origin.resolvedTo) {
    const destKind = /music/i.test(origin.resolvedTo) ? 'youtubeMusic' : 'youtube';
    return `${mdLink(origin.platform, origin.platformUrl)} → ${withSourceEmoji(
      mdLink(origin.resolvedTo, playUrl),
      destKind
    )}`;
  }
  if (kind === 'youtubeMusic') {
    return withSourceEmoji(mdLink('YouTube Music', playUrl || origin.platformUrl), 'youtubeMusic');
  }
  if (kind === 'youtube') {
    return withSourceEmoji(mdLink('YouTube', playUrl || origin.platformUrl), 'youtube');
  }
  const label = origin.platform || 'YouTube Music';
  return withSourceEmoji(mdLink(label, playUrl || origin.platformUrl), label);
}

function trackTitleLine(track) {
  const title = realMeta(track?.title);
  const artist = realMeta(track?.artist);
  if (title && artist && title.toLowerCase() !== artist.toLowerCase()) {
    return `${bt(title)} — ${artist}`;
  }
  if (title) return bt(title);
  if (artist) return artist;
  return '';
}

function trackDescription(track) {
  const source = sourceLine(track);
  const name = trackTitleLine(track);
  return name ? `${source}\n${name}` : source;
}

function applyArtwork(embed, track) {
  const art = displayArtwork(track);
  if (art) embed.setThumbnail(art);
  return embed;
}

function formatDuration(sec) {
  if (!sec && sec !== 0) return null;
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

function addedEmbed(track, position, requesterTag) {
  const embed = new EmbedBuilder()
    .setTitle(position === 1 ? 'Now playing' : 'Added to queue')
    .setDescription(trackDescription(track))
    .setColor(position === 1 ? COLORS.nowPlaying : COLORS.play)
    .addFields(
      {
        name: 'Position',
        value:
          position === 1
            ? '#1 — Now playing'
            : position === 2
              ? '#2 — Next'
              : `#${position} in queue`,
        inline: true,
      },
      { name: 'Requested by', value: requesterTag || 'Unknown', inline: true }
    )
    .setFooter({ text: '/play' });
  return applyArtwork(embed, track);
}

function searchingEmbed(query) {
  return new EmbedBuilder()
    .setTitle('Searching…')
    .setDescription(`Looking up ${bt(String(query).slice(0, 200))}`)
    .setColor(COLORS.queue)
    .setFooter({ text: '/play' });
}

function playlistAddedEmbed(playlist, firstTrack, loadedCount, totalCount, requesterTag, started) {
  const platform = withSourceEmoji(
    mdLink(playlist.platform || 'Playlist', playlist.platformUrl),
    playlist.platform
  );
  const title = bt(playlist.name || 'Playlist');
  const first = firstTrack ? `\nFirst: ${trackTitleLine(firstTrack)}` : '';
  const embed = new EmbedBuilder()
    .setTitle(started ? 'Playing playlist' : 'Playlist queued')
    .setDescription(`${platform}\n${title}${first}`)
    .setColor(started ? COLORS.nowPlaying : COLORS.play)
    .addFields(
      {
        name: 'Tracks',
        value: `${loadedCount}/${totalCount} ready${loadedCount < totalCount ? ' (matching…)' : ''}`,
        inline: true,
      },
      { name: 'Requested by', value: requesterTag || 'Unknown', inline: true }
    )
    .setFooter({ text: '/play · playlist' });
  const album =
    playlist.artwork && !isYoutubeClipThumb(playlist.artwork) ? playlist.artwork : null;
  if (album) embed.setThumbnail(album);
  else applyArtwork(embed, firstTrack);
  return embed;
}

function nowPlayingEmbed(track, volume, elapsedSec) {
  const progress = formatDuration(elapsedSec);
  const total = formatDuration(track.durationSec);
  const progressText = progress && total ? `${progress} / ${total}` : total || '—';

  const embed = new EmbedBuilder()
    .setTitle('Now playing')
    .setDescription(trackDescription(track))
    .setColor(COLORS.nowPlaying)
    .addFields(
      { name: 'Progress', value: progressText, inline: true },
      { name: 'Volume', value: `${volume}%`, inline: true }
    )
    .setFooter({ text: '/nowplaying' });
  return applyArtwork(embed, track);
}

/** Discord embeds cap at 4096 chars — show a readable head, not a cut line. */
const QUEUE_PREVIEW = 20;

function queueEmbed(tracks, current) {
  const lines = [];
  if (current) {
    lines.push(`**1.** ${trackTitleLine(current) || sourceLine(current)} *(now)*`);
  }
  tracks.forEach((t, i) => {
    const n = (current ? 2 : 1) + i;
    lines.push(`**${n}.** ${trackTitleLine(t) || sourceLine(t)}`);
  });

  if (!lines.length) {
    return new EmbedBuilder()
      .setTitle('Queue')
      .setDescription('Queue is empty.')
      .setColor(COLORS.queue)
      .setFooter({ text: '/queue' });
  }

  const total = lines.length;
  if (total > QUEUE_PREVIEW) {
    lines.splice(QUEUE_PREVIEW, total - QUEUE_PREVIEW, `…and **${total - QUEUE_PREVIEW}** more`);
  }
  return new EmbedBuilder()
    .setTitle(`Queue — ${total} track${total > 1 ? 's' : ''}`)
    .setDescription(lines.join('\n').slice(0, 4000))
    .setColor(COLORS.queue)
    .setFooter({ text: '/queue' });
}

function skippedEmbed(skipped, next) {
  const skippedName = trackTitleLine(skipped) || sourceLine(skipped);
  let desc = `Skipped ${skippedName}`;
  if (next) {
    const nextName = trackTitleLine(next);
    desc += `\nNow: ${sourceLine(next)}${nextName ? ` — ${nextName}` : ''}`;
  }
  const embed = new EmbedBuilder()
    .setTitle('Skipped')
    .setDescription(desc)
    .setColor(COLORS.skip)
    .setFooter({ text: '/skip' });
  if (next) applyArtwork(embed, next);
  return embed;
}

function skipVoteEmbed({ votes, needed, already }) {
  const left = Math.max(0, needed - votes);
  const extra = already
    ? '\nYou already voted for this track.'
    : left
      ? `\n${left} more vote${left > 1 ? 's' : ''} needed.`
      : '';
  return new EmbedBuilder()
    .setTitle('Skip vote')
    .setDescription(`**${votes}/${needed}** of the voice channel voted to skip.${extra}\nVotes reset when the next track starts.`)
    .setColor(COLORS.skip)
    .setFooter({ text: '/skip' });
}

function stopVoteEmbed({ votes, needed, already }) {
  const left = Math.max(0, needed - votes);
  const extra = already
    ? '\nYou already voted for this track.'
    : left
      ? `\n${left} more vote${left > 1 ? 's' : ''} needed.`
      : '';
  return new EmbedBuilder()
    .setTitle('Stop vote')
    .setDescription(`**${votes}/${needed}** of the voice channel voted to stop.${extra}\nVotes reset when the next track starts.`)
    .setColor(COLORS.stop)
    .setFooter({ text: '/stop' });
}

function pausedEmbed(track) {
  return new EmbedBuilder()
    .setTitle('Paused')
    .setDescription(`Paused ${trackTitleLine(track) || sourceLine(track)}\nUse /resume to continue.`)
    .setColor(COLORS.pause)
    .setFooter({ text: '/pause' });
}

function resumedEmbed(track) {
  return new EmbedBuilder()
    .setTitle('Resumed')
    .setDescription(`Resumed ${trackTitleLine(track) || sourceLine(track)}`)
    .setColor(COLORS.resume)
    .setFooter({ text: '/resume' });
}

function volumeEmbed(volume) {
  return new EmbedBuilder()
    .setTitle('Volume')
    .setDescription(`Session volume set to **${volume}%**`)
    .setColor(COLORS.volume)
    .setFooter({ text: `/volume ${volume}` });
}

function stoppedEmbed() {
  return new EmbedBuilder()
    .setTitle('Stopped')
    .setDescription('Playback stopped, queue cleared, left the voice channel.')
    .setColor(COLORS.stop)
    .setFooter({ text: '/stop' });
}

function errorEmbed(message) {
  return new EmbedBuilder()
    .setTitle('Error')
    .setDescription(message)
    .setColor(COLORS.error);
}

function settingsMainEmbed(settings, labels) {
  return new EmbedBuilder()
    .setTitle('Music settings')
    .setDescription('Only you can see this.\nChoose a parameter:')
    .setColor(COLORS.settings)
    .addFields(
      {
        name: '1 — Playback mode',
        value: `Current: ${bt(labels.playbackMode)}`,
        inline: false,
      },
      {
        name: '2 — Link resolution',
        value: `Current: ${bt(labels.linkResolution)}`,
        inline: false,
      },
      {
        name: '3 — Default volume',
        value: `Current: ${bt(`${settings.defaultVolume}%`)}`,
        inline: false,
      }
    )
    .setFooter({ text: '/settings · step 1' });
}

function settingsValueEmbed(paramKey) {
  if (paramKey === 'playbackMode') {
    return new EmbedBuilder()
      .setTitle('Playback mode')
      .setDescription('Choose a value:')
      .setColor(COLORS.settings)
      .addFields(
        { name: '1 — Stream', value: `${bt('Stream')} — play directly (default)`, inline: false },
        {
          name: '2 — Temp download',
          value: `${bt('Temp download')} — cache YT/YT Music, delete when done`,
          inline: false,
        }
      )
      .setFooter({ text: '/settings · step 2' });
  }
  if (paramKey === 'linkResolution') {
    return new EmbedBuilder()
      .setTitle('Link resolution')
      .setDescription('Choose a value:')
      .setColor(COLORS.settings)
      .addFields({
        name: '1 — YouTube Music priority',
        value: `${bt('YouTube Music priority')} — Spotify/Apple/Deezer → YouTube Music`,
        inline: false,
      })
      .setFooter({ text: '/settings · step 2' });
  }
  return new EmbedBuilder()
    .setTitle('Default volume')
    .setDescription('Choose a value:')
    .setColor(COLORS.settings)
    .addFields(
      { name: '1 — 25%', value: bt('25%'), inline: true },
      { name: '2 — 50%', value: bt('50%'), inline: true },
      { name: '3 — 75%', value: bt('75%'), inline: true },
      { name: '4 — 100%', value: bt('100%'), inline: true }
    )
    .setFooter({ text: '/settings · step 2' });
}

function settingsUpdatedEmbed(paramLabel, valueLabel) {
  return new EmbedBuilder()
    .setTitle('Setting updated')
    .setDescription(`${bt(paramLabel)} → ${bt(valueLabel)}`)
    .setColor(COLORS.resume)
    .setFooter({ text: '/settings · done' });
}



function canConfigure(interaction) {
  return interaction.memberPermissions?.has(PermissionsBitField.Flags.MoveMembers);
}

function labelsFor(settings) {
  return {
    playbackMode: PLAYBACK_MODE_LABELS[settings.playbackMode] || settings.playbackMode,
    linkResolution: LINK_RESOLUTION_LABELS[settings.linkResolution] || settings.linkResolution,
  };
}

function paramSelectRow() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('music_settings_param')
      .setPlaceholder('1 / 2 / 3 — choose a parameter')
      .addOptions(
        new StringSelectMenuOptionBuilder()
          .setLabel('1 — Playback mode')
          .setDescription('Stream or temp download')
          .setValue('playbackMode'),
        new StringSelectMenuOptionBuilder()
          .setLabel('2 — Link resolution')
          .setDescription('YouTube Music priority')
          .setValue('linkResolution'),
        new StringSelectMenuOptionBuilder()
          .setLabel('3 — Default volume')
          .setDescription('25 / 50 / 75 / 100')
          .setValue('defaultVolume')
      )
  );
}

function valueSelectRow(paramKey) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`music_settings_value:${paramKey}`)
    .setPlaceholder('Choose a value');

  if (paramKey === 'playbackMode') {
    menu.addOptions(
      new StringSelectMenuOptionBuilder().setLabel('1 — Stream').setValue('stream'),
      new StringSelectMenuOptionBuilder().setLabel('2 — Temp download').setValue('tempDownload')
    );
  } else if (paramKey === 'linkResolution') {
    menu.addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel('1 — YouTube Music priority')
        .setValue('youtubeMusic')
    );
  } else {
    menu.addOptions(
      new StringSelectMenuOptionBuilder().setLabel('1 — 25%').setValue('25'),
      new StringSelectMenuOptionBuilder().setLabel('2 — 50%').setValue('50'),
      new StringSelectMenuOptionBuilder().setLabel('3 — 75%').setValue('75'),
      new StringSelectMenuOptionBuilder().setLabel('4 — 100%').setValue('100')
    );
  }

  return new ActionRowBuilder().addComponents(menu);
}

async function handleSettingsCommand(interaction) {
  const settings = getGuildSettings(interaction.guildId);
  const labels = labelsFor(settings);
  await interaction.reply({
    embeds: [settingsMainEmbed(settings, labels)],
    components: [paramSelectRow()],
    flags: MessageFlags.Ephemeral,
  });
}

async function handleSettingsSelect(interaction) {
  if (!interaction.isStringSelectMenu()) return false;
  if (
    interaction.customId !== 'music_settings_param' &&
    !interaction.customId.startsWith('music_settings_value:')
  ) {
    return false;
  }

  if (!canConfigure(interaction)) {
    await interaction.reply({
      content: "You don't have the 'Move Members' permission to use this.",
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  if (interaction.customId === 'music_settings_param') {
    const paramKey = interaction.values[0];
    await interaction.update({
      embeds: [settingsValueEmbed(paramKey)],
      components: [valueSelectRow(paramKey)],
    });
    return true;
  }

  if (interaction.customId.startsWith('music_settings_value:')) {
    const paramKey = interaction.customId.split(':')[1];
    const raw = interaction.values[0];

    let value = raw;
    let paramLabel = paramKey;
    let valueLabel = raw;

    if (paramKey === 'playbackMode') {
      paramLabel = 'Playback mode';
      valueLabel = PLAYBACK_MODE_LABELS[raw] || raw;
    } else if (paramKey === 'linkResolution') {
      paramLabel = 'Link resolution';
      valueLabel = LINK_RESOLUTION_LABELS[raw] || raw;
    } else if (paramKey === 'defaultVolume') {
      paramLabel = 'Default volume';
      value = Number(raw);
      valueLabel = `${value}%`;
    }

    setGuildSetting(interaction.guildId, paramKey, value);

    await interaction.update({
      embeds: [settingsUpdatedEmbed(paramLabel, valueLabel)],
      components: [],
    });
    return true;
  }

  return false;
}



const SUDO_TTL_MS = 3 * 60 * 1000;
const pendingSudo = new Map();

function sudoKey(interaction) {
  return `${interaction.guildId}:${interaction.channelId}`;
}

function rememberSudo(interaction, payload) {
  pendingSudo.set(sudoKey(interaction), {
    ...payload,
    userId: interaction.user.id,
    at: Date.now(),
  });
}

function takeSudo(interaction) {
  const key = sudoKey(interaction);
  const pending = pendingSudo.get(key);
  if (!pending) return null;
  pendingSudo.delete(key);
  if (Date.now() - pending.at > SUDO_TTL_MS) return null;
  return pending;
}

function requireVoice(interaction) {
  const channel = interaction.member?.voice?.channel;
  if (!channel) {
    return { error: 'You must be in a voice channel to use this command.' };
  }
  return { channel };
}

function voiceListenerIds(interaction, music) {
  const channelId =
    music.connection?.joinConfig?.channelId || interaction.member?.voice?.channelId;
  const channel = interaction.guild?.channels.cache.get(channelId);
  if (!channel?.isVoiceBased()) return [];
  return [...channel.members.filter((m) => !m.user.bot).keys()];
}

/**
 * Requester of the current track skips/stops instantly.
 * Everyone else needs ceil(listeners / 2) votes. Votes reset per track.
 */
function requestPlaybackControl(interaction, music, kind) {
  const userId = interaction.user.id;
  const listeners = voiceListenerIds(interaction, music);
  if (!listeners.includes(userId)) {
    return { error: 'Join the bot’s voice channel to skip or stop.' };
  }
  if (String(music.current?.requestedBy || '') === String(userId)) {
    return { pass: true, reason: 'requester' };
  }

  const bag = kind === 'stop' ? music.stopVotes : music.skipVotes;
  const already = bag.has(userId);
  bag.add(userId);
  for (const id of [...bag]) {
    if (!listeners.includes(id)) bag.delete(id);
  }
  const votes = bag.size;
  const needed = Math.max(1, Math.ceil(listeners.length / 2));
  if (votes >= needed) {
    return { pass: true, reason: 'vote', votes, needed };
  }
  return { pass: false, votes, needed, already };
}

async function ensureTrackLabel(track) {
  if (!track) return;
  if (realMeta(track.title) && realMeta(track.artist)) return;
  await hydrateYoutubeMeta(track, 800).catch(() => {});
}

async function playResolved(interaction, channel, resolved) {
  const music = getGuildMusic(interaction.guildId);
  const requester = `<@${interaction.user.id}>`;

  if (resolved.type === 'playlist') {
    const total = Math.min(resolved.entries.length, MAX_PLAYLIST_TRACKS);
    const requesterId = interaction.user.id;

    if (resolved.alreadyMatched) {
      const tracks = resolved.entries
        .slice(0, MAX_PLAYLIST_TRACKS)
        .map((e) => e.track)
        .filter(Boolean);
      for (const t of tracks) t.requestedBy = requesterId;
      const first = tracks[0];
      const rest = tracks.slice(1);
      const result = await music.playOrEnqueuePlaylist(first, rest, channel, interaction.channel);
      await ensureTrackLabel(first);
      await interaction.editReply({
        embeds: [
          playlistAddedEmbed(resolved, first, tracks.length, total, requester, result.started),
        ],
      });
      return;
    }

    const first = await resolveFirstPlaylistTrack(resolved);
    first.requestedBy = requesterId;

    const result = await music.playOrEnqueue(first, channel, interaction.channel);
    await ensureTrackLabel(first);

    await interaction.editReply({
      embeds: [playlistAddedEmbed(resolved, first, 1, total, requester, result.started)],
    });

    resolvePlaylistRest(resolved, async (track) => {
      track.requestedBy = requesterId;
      music.enqueue(track);
    })
      .then(async ({ ok, fail }) => {
        console.log(`[music] playlist done: +${ok} queued, ${fail} skipped`);
        try {
          await interaction.editReply({
            embeds: [
              playlistAddedEmbed(resolved, first, 1 + ok, total, requester, result.started),
            ],
          });
        } catch {
          /* interaction may be stale */
        }
      })
      .catch((err) => console.error('[music] playlist background error:', err.message));
    return;
  }

  const track = resolved.track;
  track.requestedBy = interaction.user.id;
  const result = await music.playOrEnqueue(track, channel, interaction.channel);
  await ensureTrackLabel(track);
  await interaction.editReply({
    embeds: [addedEmbed(track, result.position, requester)],
  });
}

function sudoVoiceChannel(interaction, pending) {
  const adminVc = interaction.member?.voice?.channel;
  if (adminVc) return adminVc;
  const music = getGuildMusic(interaction.guildId);
  const botChId = music.connection?.joinConfig?.channelId;
  if (botChId) {
    const ch = interaction.guild?.channels.cache.get(botChId);
    if (ch?.isVoiceBased()) return ch;
  }
  const original = interaction.guild?.members.cache.get(pending.userId);
  return original?.voice?.channel || null;
}

async function handleSudoCommand(interaction) {
  if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
    await interaction.reply({
      content: "You don't have the Administrator permission to use /sudo.",
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  const pending = takeSudo(interaction);
  if (!pending) {
    await interaction.reply({
      content: 'Nothing to override in this channel (no recent denied music command).',
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  const music = getGuildMusic(interaction.guildId);
  console.log(`[music] /sudo overrides /${pending.command} (from <@${pending.userId}>)`);

  if (pending.command === 'skip') {
    if (!music.current) {
      await interaction.reply({ embeds: [errorEmbed('Nothing is playing.')], flags: MessageFlags.Ephemeral });
      return true;
    }
    const { skipped, next } = music.skip();
    await interaction.reply({ embeds: [skippedEmbed(skipped, next)] });
    return true;
  }

  if (pending.command === 'stop') {
    music.stop();
    await interaction.reply({ embeds: [stoppedEmbed()] });
    return true;
  }

  if (pending.command === 'pause') {
    if (!music.current) {
      await interaction.reply({ embeds: [errorEmbed('Nothing is playing.')], flags: MessageFlags.Ephemeral });
      return true;
    }
    if (!music.pause()) {
      await interaction.reply({ embeds: [errorEmbed('Already paused or not playing.')], flags: MessageFlags.Ephemeral });
      return true;
    }
    await interaction.reply({ embeds: [pausedEmbed(music.current)] });
    return true;
  }

  if (pending.command === 'resume') {
    if (!music.current) {
      await interaction.reply({ embeds: [errorEmbed('Nothing is playing.')], flags: MessageFlags.Ephemeral });
      return true;
    }
    if (!music.resume()) {
      await interaction.reply({ embeds: [errorEmbed('Nothing is paused.')], flags: MessageFlags.Ephemeral });
      return true;
    }
    await interaction.reply({ embeds: [resumedEmbed(music.current)] });
    return true;
  }

  if (pending.command === 'volume') {
    const vol = music.setVolume(pending.level ?? 50);
    await interaction.reply({ embeds: [volumeEmbed(vol)] });
    return true;
  }

  if (pending.command === 'play' || pending.command === 'playlist') {
    const channel = sudoVoiceChannel(interaction, pending);
    if (!channel) {
      await interaction.reply({
        embeds: [errorEmbed('Need a voice channel to override that play command.')],
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }
    try {
      await interaction.deferReply();
    } catch (err) {
      console.error('[music] /sudo defer failed:', err.message);
      return true;
    }
    try {
      const mode = pending.command === 'playlist' ? 'playlist' : 'track';
      const resolved = await resolvePlayInput(pending.query, { mode });
      await playResolved(interaction, channel, resolved);
    } catch (err) {
      const msg = err.message || 'Failed to play that.';
      await interaction.editReply({ embeds: [errorEmbed(msg)] }).catch(() => {});
    }
    return true;
  }

  await interaction.reply({
    content: `Cannot override /${pending.command}.`,
    flags: MessageFlags.Ephemeral,
  });
  return true;
}

async function handleMusicCommand(interaction) {
  const { commandName } = interaction;
  setEmojiGuild(interaction.guild);

  if (commandName === 'sudo') {
    return handleSudoCommand(interaction);
  }

  if (commandName === 'settings') {
    await handleSettingsCommand(interaction);
    return true;
  }

  if (commandName === 'play' || commandName === 'playlist') {
    // Defer immediately — playlist search can exceed Discord's 3s limit
    try {
      await interaction.deferReply();
    } catch (err) {
      console.error(`[music] /${commandName} defer failed:`, err.message);
      return true;
    }

    const { channel, error } = requireVoice(interaction);
    if (error) {
      rememberSudo(interaction, {
        command: commandName,
        query: interaction.options.getString('query', true),
      });
      await interaction.editReply({ embeds: [errorEmbed(error)] });
      return true;
    }

    const query = interaction.options.getString('query', true);
    const mode = commandName === 'playlist' ? 'playlist' : 'track';

    try {
      console.log(`[music] /${commandName} query=${query}`);
      const music = getGuildMusic(interaction.guildId);
      // Immediate feedback + join while resolving
      const feedbackP =
        mode === 'track' && !/^https?:\/\//i.test(query.trim())
          ? interaction.editReply({ embeds: [searchingEmbed(query)] }).catch(() => {})
          : Promise.resolve();
      const joinP = music.ensureConnection(channel).catch((err) => {
        console.warn('[music] early join:', err.message);
        return null;
      });

      const resolved = await resolvePlayInput(query, { mode });
      await Promise.all([joinP, feedbackP]);
      await playResolved(interaction, channel, resolved);
    } catch (err) {
      console.error(`[music] /${commandName} error:`, err);
      const msg = err.message || 'Failed to play that.';
      const friendly = /not available|unavailable|DRM/i.test(msg)
        ? 'This YouTube video cannot be streamed (blocked / kids / DRM). Try another link or a text search.'
        : msg;
      await interaction.editReply({
        embeds: [errorEmbed(friendly)],
      }).catch(() => {});
    }
    return true;
  }

  if (commandName === 'skip') {
    const music = getGuildMusic(interaction.guildId);
    if (!music.current) {
      await interaction.reply({ embeds: [errorEmbed('Nothing is playing.')], flags: MessageFlags.Ephemeral });
      return true;
    }
    const vote = requestPlaybackControl(interaction, music, 'skip');
    if (vote.error) {
      rememberSudo(interaction, { command: 'skip' });
      await interaction.reply({ embeds: [errorEmbed(vote.error)], flags: MessageFlags.Ephemeral });
      return true;
    }
    if (!vote.pass) {
      rememberSudo(interaction, { command: 'skip' });
      await interaction.reply({
        embeds: [skipVoteEmbed({ votes: vote.votes, needed: vote.needed, already: vote.already })],
      });
      return true;
    }
    const { skipped, next } = music.skip();
    await interaction.reply({ embeds: [skippedEmbed(skipped, next)] });
    return true;
  }

  if (commandName === 'stop') {
    const music = getGuildMusic(interaction.guildId);
    if (!music.current && music.queue.length === 0 && !music.connection) {
      await interaction.reply({ embeds: [errorEmbed('Nothing is playing.')], flags: MessageFlags.Ephemeral });
      return true;
    }
    const vote = requestPlaybackControl(interaction, music, 'stop');
    if (vote.error) {
      rememberSudo(interaction, { command: 'stop' });
      await interaction.reply({ embeds: [errorEmbed(vote.error)], flags: MessageFlags.Ephemeral });
      return true;
    }
    if (!vote.pass) {
      rememberSudo(interaction, { command: 'stop' });
      await interaction.reply({
        embeds: [stopVoteEmbed({ votes: vote.votes, needed: vote.needed, already: vote.already })],
      });
      return true;
    }
    music.stop();
    await interaction.reply({ embeds: [stoppedEmbed()] });
    return true;
  }

  if (commandName === 'pause') {
    const music = getGuildMusic(interaction.guildId);
    if (!music.current) {
      await interaction.reply({ embeds: [errorEmbed('Nothing is playing.')], flags: MessageFlags.Ephemeral });
      return true;
    }
    if (!music.pause()) {
      await interaction.reply({ embeds: [errorEmbed('Already paused or not playing.')], flags: MessageFlags.Ephemeral });
      return true;
    }
    await interaction.reply({ embeds: [pausedEmbed(music.current)] });
    return true;
  }

  if (commandName === 'resume') {
    const music = getGuildMusic(interaction.guildId);
    if (!music.current) {
      await interaction.reply({ embeds: [errorEmbed('Nothing is playing.')], flags: MessageFlags.Ephemeral });
      return true;
    }
    if (!music.resume()) {
      await interaction.reply({ embeds: [errorEmbed('Nothing is paused.')], flags: MessageFlags.Ephemeral });
      return true;
    }
    await interaction.reply({ embeds: [resumedEmbed(music.current)] });
    return true;
  }

  if (commandName === 'queue') {
    const music = getGuildMusic(interaction.guildId);
    await interaction.reply({
      embeds: [queueEmbed(music.queue, music.current)],
    });
    return true;
  }

  if (commandName === 'nowplaying') {
    const music = getGuildMusic(interaction.guildId);
    if (!music.current) {
      await interaction.reply({ embeds: [errorEmbed('Nothing is playing.')], flags: MessageFlags.Ephemeral });
      return true;
    }
    await interaction.reply({
      embeds: [nowPlayingEmbed(music.current, music.volume, music.getElapsedSec())],
    });
    return true;
  }

  if (commandName === 'volume') {
    const level = interaction.options.getInteger('level', true);
    const music = getGuildMusic(interaction.guildId);
    const vol = music.setVolume(level);
    await interaction.reply({ embeds: [volumeEmbed(vol)] });
    return true;
  }

  return false;
}



const MUSIC_ENGINE = 'yt-dlp-pipe+ffmpeg-pcm';

function logMusicEngine() {
  console.log(`[music] engine=${MUSIC_ENGINE}`);
  console.log('[music] playback=pipe (FFmpeg must not open googlevideo URLs)');
  const report = generateDependencyReport();
  console.log(report);
  if (report.includes('@discordjs/opus: not found')) {
    console.warn('[music] @discordjs/opus missing — encoding via FFmpeg libopus (run npm install on the host)');
  }
}

async function warmMusic() {
  try {
    ensureFfmpeg();
    const bin = await getYtDlp();
    console.log(`[music] warm: yt-dlp ready (${bin})`);
    await updateYtDlp();
  } catch (err) {
    console.warn('[music] warm failed:', err.message);
  }
}

module.exports = {
  handleMusicCommand,
  handleSettingsSelect,
  maybeLeaveIfEmpty,
  getFfmpegPath,
  logMusicEngine,
  warmMusic,
  MUSIC_ENGINE,
};
