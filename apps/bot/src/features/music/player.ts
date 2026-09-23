import {
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  type AudioPlayer,
  type AudioResource,
  type VoiceConnection,
} from '@discordjs/voice';
import type { Guild, Message, VoiceBasedChannel } from 'discord.js';
import { log } from '../../core/log.js';
import { ensurePlayable, type Found } from './search.js';
import { openStream, type AudioStream } from './tools.js';

export interface Track extends Found {
  requesterId: string;
}

export type LoopMode = 'off' | 'track' | 'queue';

const IDLE_LEAVE_MS = 3 * 60_000; // queue finished
const EMPTY_LEAVE_MS = 60_000; // nobody left in the channel

/** Everything Ditto plays in one server. */
export class GuildMusic {
  readonly queue: Track[] = [];
  current: Track | null = null;
  loop: LoopMode = 'off';
  volume = 60;
  startedAt = 0;
  pausedAt = 0;
  /** Where the "now playing" message goes. */
  textChannelId: string | null = null;
  nowPlaying: Message | null = null;
  readonly skipVotes = new Set<string>();
  readonly stopVotes = new Set<string>();

  private connection: VoiceConnection | null = null;
  private player: AudioPlayer;
  private resource: AudioResource<Track> | null = null;
  private audio: AudioStream | null = null;
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
  ) {
    this.player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
    this.player.on(AudioPlayerStatus.Idle, () => void this.advance());
    this.player.on('error', (err) => {
      log.warn('music', `${guild.name}: ${err.message}`);
      if (this.current) this.hooks.onError(this, this.current, err);
    });
  }

  get channelId() {
    return this.connection?.joinConfig.channelId ?? null;
  }

  get paused() {
    return this.player.state.status === AudioPlayerStatus.Paused || this.player.state.status === AudioPlayerStatus.AutoPaused;
  }

  /** Seconds played in the current track. */
  get position() {
    if (!this.current || !this.startedAt) return 0;
    const now = this.paused ? this.pausedAt : Date.now();
    return Math.max(0, Math.floor((now - this.startedAt) / 1000));
  }

  async connect(channel: VoiceBasedChannel) {
    if (this.connection && this.channelId === channel.id) return;
    this.connection?.destroy();
    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: this.guild.id,
      adapterCreator: this.guild.voiceAdapterCreator,
      selfDeaf: true,
    });
    this.connection = connection;
    connection.subscribe(this.player);
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      // Moved to another channel: it reconnects on its own. Kicked: clean up.
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5000),
        ]);
      } catch {
        this.destroy();
      }
    });
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
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

  private async advance() {
    if (this.destroyed) return;
    this.stopAudio();
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
      this.audio = await openStream(track.url);
      this.resource = createAudioResource(this.audio.stream, { inputType: StreamType.Raw, inlineVolume: true, metadata: track });
      this.resource.volume?.setVolume(this.volume / 100);
      this.player.play(this.resource);
      this.startedAt = Date.now();
      this.hooks.onTrackStart(this);
    } catch (err) {
      this.hooks.onError(this, track, err as Error);
      // Skip what cannot be played instead of stalling the queue — and never loop back to it.
      this.current = null;
      await this.advance();
    }
  }

  private stopAudio() {
    this.audio?.kill();
    this.audio = null;
    this.resource = null;
  }

  skip() {
    // Idle fires advance(); a looped track would otherwise start again.
    if (this.loop === 'track') this.current = null;
    this.player.stop(true);
  }

  pause() {
    if (this.player.pause()) this.pausedAt = Date.now();
  }

  resume() {
    if (this.paused && this.player.unpause()) {
      this.startedAt += Date.now() - this.pausedAt;
      this.pausedAt = 0;
    }
  }

  setVolume(level: number) {
    this.volume = level;
    this.resource?.volume?.setVolume(level / 100);
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

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearIdle();
    if (this.emptyTimer) clearTimeout(this.emptyTimer);
    this.queue.length = 0;
    this.current = null;
    this.player.stop(true);
    this.stopAudio();
    try {
      this.connection?.destroy();
    } catch {
      /* already gone */
    }
    this.connection = null;
    this.hooks.onDestroy(this);
  }
}
