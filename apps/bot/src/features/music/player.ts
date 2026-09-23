import fs from 'node:fs';
import type { Guild, Message, VoiceBasedChannel } from 'discord.js';
import { log } from '../../core/log.js';
import { lavalink, loadEncoded, type LavalinkPlayer } from './engine.js';
import { ensurePlayable, UserError, type Found, type Source } from './search.js';
import { directAudioUrl, downloadAudio } from './tools.js';

export interface Track extends Found {
  requesterId: string;
}

export type LoopMode = 'off' | 'track' | 'queue';
export type FilterName = 'none' | 'bassboost' | 'nightcore' | 'vaporwave' | '8d' | 'karaoke';

const IDLE_LEAVE_MS = 3 * 60_000; // queue finished
const EMPTY_LEAVE_MS = 60_000; // nobody left in the channel

/** Short clips from these sites are downloaded first: Lavalink cannot read their pages. */
const DOWNLOAD_FIRST: Source[] = ['tiktok', 'x', 'instagram'];

/**
 * Turns a track into something Lavalink can play, trying in order: Lavalink on the page
 * itself, the direct media address found by yt-dlp, then a downloaded copy.
 */
async function toLavalink(track: Track): Promise<{ encoded: string; file?: string }> {
  const viaDownload = async () => {
    const file = await downloadAudio(track.url);
    const r = await loadEncoded(file);
    if (!r.encoded) throw new Error(r.error ?? 'unreadable file');
    return { encoded: r.encoded, file };
  };
  if (DOWNLOAD_FIRST.includes(track.source)) return viaDownload();

  const direct = await loadEncoded(track.url);
  if (direct.encoded) return { encoded: direct.encoded };
  log.warn('music', `Lavalink could not load ${track.url} (${direct.error}), trying yt-dlp`);

  try {
    const r = await loadEncoded(await directAudioUrl(track.url));
    if (r.encoded) return { encoded: r.encoded };
  } catch {
    /* next fallback */
  }
  if (!track.live && (track.duration ?? 0) <= 20 * 60) return viaDownload();
  throw new UserError('This track could not be loaded.', 'Ce titre n’a pas pu être chargé.');
}

/** Everything Ditto plays in one server. */
export class GuildMusic {
  readonly queue: Track[] = [];
  current: Track | null = null;
  loop: LoopMode = 'off';
  filter: FilterName = 'none';
  volume = 60;
  /** Where the "now playing" message goes. */
  textChannelId: string | null = null;
  nowPlaying: Message | null = null;
  readonly skipVotes = new Set<string>();
  readonly stopVotes = new Set<string>();

  private player: LavalinkPlayer | null = null;
  private tempFile: string | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private emptyTimer: NodeJS.Timeout | null = null;
  private destroyed = false;

  constructor(
    readonly guild: Guild,
    private readonly hooks: {
      onTrackStart(music: GuildMusic): void;
      onQueueEnd(music: GuildMusic): void;
      onError(music: GuildMusic, track: Track, error: Error): void;
      onDestroy(music: GuildMusic): void;
    }
  ) {}

  get channelId() {
    return this.player?.voiceChannelId ?? null;
  }

  get paused() {
    return this.player?.paused ?? false;
  }

  /** Seconds played in the current track. */
  get position() {
    return this.current ? Math.floor((this.player?.position ?? 0) / 1000) : 0;
  }

  async connect(channel: VoiceBasedChannel) {
    const manager = lavalink();
    this.player ??=
      manager.getPlayer(this.guild.id) ??
      manager.createPlayer({
        guildId: this.guild.id,
        voiceChannelId: channel.id,
        textChannelId: this.textChannelId ?? undefined,
        selfDeaf: true,
        volume: this.volume,
      });
    if (this.player.connected && this.player.voiceChannelId !== channel.id) {
      await this.player.changeVoiceState({ voiceChannelId: channel.id, selfDeaf: true });
    } else if (!this.player.connected) {
      this.player.voiceChannelId = channel.id;
      await this.player.connect();
    }
  }

  /** Adds tracks; starts playing if nothing is. Returns the queue position of the first one (0 = playing now). */
  async enqueue(tracks: Track[]) {
    this.clearIdle();
    const wasPlaying = !!this.current;
    this.queue.push(...tracks);
    if (!wasPlaying) {
      await this.advance();
      return 0;
    }
    return this.queue.length - tracks.length + 1;
  }

  /** Called by the engine when Lavalink reports the end of a track. */
  onEnded() {
    void this.advance();
  }

  private async advance() {
    if (this.destroyed) return;
    this.dropTempFile();
    const previous = this.current;
    this.skipVotes.clear();
    this.stopVotes.clear();

    let next: Track | undefined;
    if (previous && this.loop === 'track') next = previous;
    else {
      if (previous && this.loop === 'queue') this.queue.push(previous);
      next = this.queue.shift();
    }

    if (!next) {
      this.current = null;
      this.hooks.onQueueEnd(this);
      this.idleTimer = setTimeout(() => this.destroy(), IDLE_LEAVE_MS);
      return;
    }
    await this.play(next);
  }

  private async play(track: Track) {
    this.current = track;
    try {
      await ensurePlayable(track);
      const { encoded, file } = await toLavalink(track);
      this.tempFile = file ?? null;
      if (!this.player) throw new Error('not connected');
      await this.player.play({ track: { encoded, requester: track.requesterId }, volume: this.volume });
      this.hooks.onTrackStart(this);
    } catch (err) {
      this.hooks.onError(this, track, err as Error);
      // Skip what cannot be played instead of stalling the queue — and never loop back to it.
      this.current = null;
      await this.advance();
    }
  }

  private dropTempFile() {
    if (this.tempFile) fs.rm(this.tempFile, { force: true }, () => {});
    this.tempFile = null;
  }

  skip() {
    // The end event calls advance(); a looped track would otherwise start again.
    if (this.loop === 'track') this.current = null;
    void this.player?.stopPlaying(false, false).catch(() => {});
  }

  pause() {
    if (!this.paused) void this.player?.pause().catch(() => {});
  }

  resume() {
    if (this.paused) void this.player?.resume().catch(() => {});
  }

  setVolume(level: number) {
    this.volume = level;
    void this.player?.setVolume(level).catch(() => {});
  }

  async seek(seconds: number) {
    await this.player?.seek(seconds * 1000);
  }

  async setFilter(name: FilterName) {
    const f = this.player?.filterManager;
    if (!f) return;
    await f.resetFilters();
    if (name === 'bassboost') await f.setEQPreset('BassboostMedium');
    else if (name === 'nightcore') await f.toggleNightcore();
    else if (name === 'vaporwave') await f.toggleVaporwave();
    else if (name === '8d') await f.toggleRotation(0.2);
    else if (name === 'karaoke') await f.toggleKaraoke();
    this.filter = name;
  }

  shuffle() {
    for (let i = this.queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]];
    }
  }

  /** Called when the listeners in the channel change. */
  checkEmpty(humans: number) {
    if (humans > 0) {
      if (this.emptyTimer) clearTimeout(this.emptyTimer);
      this.emptyTimer = null;
    } else if (!this.emptyTimer) {
      this.emptyTimer = setTimeout(() => this.destroy(), EMPTY_LEAVE_MS);
    }
  }

  private clearIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  /** `fromLavalink`: the player is already gone on Lavalink's side. */
  destroy(fromLavalink = false) {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearIdle();
    if (this.emptyTimer) clearTimeout(this.emptyTimer);
    this.queue.length = 0;
    this.current = null;
    this.dropTempFile();
    if (!fromLavalink) void this.player?.destroy('stopped').catch(() => {});
    this.player = null;
    this.hooks.onDestroy(this);
  }
}
