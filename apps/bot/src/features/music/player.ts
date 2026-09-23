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

// ---------- Routes to a playable track ----------

/**
 * How a track reaches Lavalink: Lavalink reading the page itself, the direct media
 * address yt-dlp finds, or a copy yt-dlp downloads. If one fails — while loading or
 * while playing — the next one is tried.
 */
export type Route = 'lavalink' | 'direct' | 'download';

/** Short clips from these sites are downloaded first: Lavalink cannot read their pages. */
const DOWNLOAD_FIRST: Source[] = ['tiktok', 'x', 'instagram'];
const MAX_DOWNLOAD_SECONDS = 20 * 60;

const isYoutube = (t: Track) => t.source === 'youtube' || t.source === 'ytmusic' || /youtu\.?be/.test(t.url);

/**
 * YouTube refuses Lavalink's own YouTube clients for most videos without a signed-in
 * account ("This video requires login"), while yt-dlp gets through, so YouTube goes
 * through yt-dlp first and Lavalink's plugin is only the fallback. Other sources are
 * read by Lavalink directly.
 */
export function routesFor(track: Track): Route[] {
  if (DOWNLOAD_FIRST.includes(track.source)) return ['download'];
  const canDownload = !track.live && (track.duration ?? 0) <= MAX_DOWNLOAD_SECONDS;
  const routes: Route[] = isYoutube(track) ? ['direct', 'lavalink'] : ['lavalink', 'direct'];
  return canDownload ? [...routes, 'download'] : routes;
}

export async function loadVia(route: Route, track: Track): Promise<{ encoded: string; file?: string }> {
  if (route === 'download') {
    const file = await downloadAudio(track.url);
    const r = await loadEncoded(file);
    if (!r.encoded) throw new Error(r.error ?? 'unreadable file');
    return { encoded: r.encoded, file };
  }
  const address = route === 'direct' ? await directAudioUrl(track.url) : track.url;
  const r = await loadEncoded(address);
  if (!r.encoded) throw new Error(r.error ?? 'nothing loaded');
  return { encoded: r.encoded };
}

// ---------- Player ----------

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
  /** The Lavalink track now playing; events about any other one are stale. */
  private currentEncoded: string | null = null;
  /** The last track handed to Lavalink, replayed as is when looping. */
  private lastEncoded: string | null = null;
  private routes: Route[] = [];
  private routeIndex = 0;
  private announced = false;
  /** The next track, already loaded while the current one plays. */
  private prepared: { track: Track; route: Route; encoded: string } | null = null;
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
    this.queueChanged();
    return this.queue.length - tracks.length + 1;
  }

  /** Lavalink reports the end of a track (finished, stopped, or failed to load). */
  onEnded(encoded: string | null) {
    if (encoded && encoded !== this.currentEncoded) return; // a track we already moved on from
    void this.advance();
  }

  /** Lavalink reports that the playing track broke: try the next route before giving up. */
  onFailed(encoded: string | null, message: string) {
    if (!this.current || (encoded && encoded !== this.currentEncoded)) return;
    const track = this.current;
    const failed = this.routes[this.routeIndex];
    log.warn('music', `${this.guild.name}: ${track.title} failed via ${failed}: ${message}`);
    this.currentEncoded = null; // the end event of the broken track must not advance the queue
    this.routeIndex++;
    void this.start(track, new Error(message));
  }

  private async advance() {
    if (this.destroyed) return;
    const previous = this.current;
    const replaying = !!previous && this.loop === 'track';
    if (!replaying) {
      this.dropTempFile();
      this.lastEncoded = null;
    }
    this.currentEncoded = null;
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
    // Replaying the same track (loop) or one prepared in advance: no loading needed.
    const again = next === previous && this.lastEncoded ? { route: this.routes[this.routeIndex], encoded: this.lastEncoded } : null;
    const ready = this.prepared?.track === next ? this.prepared : again;
    this.prepared = null;
    this.current = next;
    this.announced = false;
    if (ready) {
      this.routes = routesFor(next);
      this.routeIndex = Math.max(0, this.routes.indexOf(ready.route));
      if (await this.playEncoded(next, ready.encoded)) return;
      this.routeIndex++; // what was prepared no longer plays: carry on with the other routes
      return this.start(next);
    }
    try {
      await ensurePlayable(next);
    } catch (err) {
      return this.giveUp(next, err as Error);
    }
    this.routes = routesFor(next);
    this.routeIndex = 0;
    await this.start(next);
  }

  /** Hands an already loaded track to Lavalink. */
  private async playEncoded(track: Track, encoded: string) {
    if (!this.player || this.current !== track) return false;
    try {
      this.currentEncoded = encoded;
      this.lastEncoded = encoded;
      await this.player.play({ track: { encoded, requester: track.requesterId }, volume: this.volume });
      if (!this.announced) {
        this.announced = true;
        this.hooks.onTrackStart(this);
      }
      this.prepareNext();
      return true;
    } catch {
      this.currentEncoded = null;
      return false;
    }
  }

  /** Loads the next track in the background (downloads excepted: those stay on demand). */
  private prepareNext() {
    const next = this.loop === 'track' ? null : this.queue[0];
    if (!next || this.prepared?.track === next) return;
    void (async () => {
      await ensurePlayable(next);
      const route = routesFor(next).find((r) => r !== 'download');
      if (!route) return;
      const { encoded } = await loadVia(route, next);
      if (this.queue[0] === next) this.prepared = { track: next, route, encoded };
    })().catch(() => {});
  }

  /** Plays `track` from the current route onwards. */
  private async start(track: Track, lastError?: Error) {
    let error = lastError;
    for (; this.routeIndex < this.routes.length; this.routeIndex++) {
      if (this.destroyed || this.current !== track) return;
      const route = this.routes[this.routeIndex];
      try {
        const { encoded, file } = await loadVia(route, track);
        this.dropTempFile();
        this.tempFile = file ?? null;
        if (!this.player || this.current !== track) return;
        if (await this.playEncoded(track, encoded)) return;
        throw new Error('Lavalink refused to play it');
      } catch (err) {
        error = err as Error;
        log.warn('music', `${this.guild.name}: ${track.title} could not load via ${route}: ${error.message}`);
      }
    }
    this.giveUp(track, error ?? new Error('no route'));
  }

  private giveUp(track: Track, error: Error) {
    this.hooks.onError(
      this,
      track,
      error instanceof UserError ? error : new UserError('This track could not be played.', 'Ce titre n’a pas pu être lu.')
    );
    // Never loop back to a track that cannot be played.
    this.current = null;
    void this.advance();
  }

  private dropTempFile() {
    if (this.tempFile) fs.rm(this.tempFile, { force: true }, () => {});
    this.tempFile = null;
  }

  skip() {
    // The end event calls advance(); a looped track would otherwise start again.
    if (this.loop === 'track') this.current = null;
    if (this.currentEncoded) void this.player?.stopPlaying(false, false).catch(() => {});
    else void this.advance(); // still loading: move on directly
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

  /** Call after changing the queue order or content. */
  queueChanged() {
    if (this.prepared && this.queue[0] !== this.prepared.track) this.prepared = null;
    if (this.current) this.prepareNext();
  }

  shuffle() {
    for (let i = this.queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]];
    }
    this.queueChanged();
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
    this.currentEncoded = null;
    this.dropTempFile();
    if (!fromLavalink) void this.player?.destroy('stopped').catch(() => {});
    this.player = null;
    this.hooks.onDestroy(this);
  }
}
