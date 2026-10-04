import fs from 'node:fs';
import type { Guild, Message, VoiceBasedChannel } from 'discord.js';
import { log } from '../../core/log.js';
import { lavalink, loadEncoded, PLAY_TAG, type LavalinkPlayer } from './engine.js';
import { assertPublicUrl, ensurePlayable, UserError, type Found, type Source } from './search.js';
import { directAudioUrl, downloadAudio, forgetDirect, isCachedAudio } from './tools.js';

export interface Track extends Found {
  requesterId: string;
}

export type LoopMode = 'off' | 'track' | 'queue';
export type FilterName = 'none' | 'bassboost' | 'nightcore' | 'vaporwave' | '8d' | 'karaoke';

const IDLE_LEAVE_MS = 3 * 60_000; // queue finished
const EMPTY_LEAVE_MS = 60_000; // nobody left in the channel
const HISTORY = 25;

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

const isYoutube = (t: Found) => t.source === 'youtube' || t.source === 'ytmusic' || /youtu\.?be/.test(t.url);

/**
 * YouTube refuses Lavalink's own YouTube clients for most videos without a signed-in
 * account ("This video requires login"), while yt-dlp gets through, so YouTube goes
 * through yt-dlp first and Lavalink's plugin is only the fallback. Other sources are
 * read by Lavalink directly.
 */
export function routesFor(track: Found): Route[] {
  if (DOWNLOAD_FIRST.includes(track.source)) return ['download'];
  const canDownload = !track.live && (track.duration ?? 0) <= MAX_DOWNLOAD_SECONDS;
  // What Lavalink has already read itself is ready to play: it goes first, YouTube or not.
  const routes: Route[] = isYoutube(track) && !track.encoded ? ['direct', 'lavalink'] : ['lavalink', 'direct'];
  return canDownload ? [...routes, 'download'] : routes;
}

export async function loadVia(route: Route, track: Found): Promise<{ encoded: string; file?: string }> {
  if (route === 'download') {
    const file = await downloadAudio(track.url);
    if (!isCachedAudio(file)) throw new Error('unexpected file');
    const r = await loadEncoded(file);
    if (!r.encoded) throw new Error(r.error ?? 'unreadable file');
    return { encoded: r.encoded, file };
  }
  // Read by Lavalink when the link was given: nothing more to load.
  if (route === 'lavalink' && track.encoded) return { encoded: track.encoded };
  if (route === 'direct') {
    // YouTube now and then refuses an address it has just handed out (HTTP 403): a
    // fresh one usually goes through, and costs less than falling back on a download.
    let error = 'nothing loaded';
    for (let attempt = 0; attempt < 2; attempt++) {
      const address = await directAudioUrl(track.url);
      await assertPublicUrl(address);
      const r = await loadEncoded(address);
      if (r.encoded) return { encoded: r.encoded };
      forgetDirect(track.url);
      error = r.error ?? error;
    }
    throw new Error(error);
  }
  await assertPublicUrl(track.url);
  const r = await loadEncoded(track.url);
  if (!r.encoded) throw new Error(r.error ?? 'nothing loaded');
  return { encoded: r.encoded };
}

/**
 * Gets a track ready ahead of time: matched on YouTube Music if it came from a
 * playlist, and its YouTube stream address looked up. Starting it is then instant.
 */
export function warm(track: Found) {
  void (async () => {
    await ensurePlayable(track);
    if (routesFor(track)[0] === 'direct') await directAudioUrl(track.url);
  })().catch(() => {});
}

// ---------- Player ----------

/** Players Lavalink is still taking down, per server: the next one waits for that to finish. */
const leaving = new Map<string, Promise<unknown>>();

/**
 * Resolves once Discord has confirmed that Ditto is out of voice in this server (three
 * seconds at most). That confirmation, arriving after a new player was created, would
 * be read as the new player being disconnected, and close it.
 */
async function outOfVoice(guild: Guild) {
  for (let k = 0; k < 30 && guild.members.me?.voice?.channelId; k++) await new Promise((r) => setTimeout(r, 100));
}

/** Everything Ditto plays in one server. */
export class GuildMusic {
  readonly queue: Track[] = [];
  /** Tracks already played, most recent last. */
  readonly history: Track[] = [];
  current: Track | null = null;
  loop: LoopMode = 'off';
  filter: FilterName = 'none';
  volume = 60;
  /** Where the player message goes. */
  textChannelId: string | null = null;
  nowPlaying: Message | null = null;
  readonly skipVotes = new Set<string>();
  readonly stopVotes = new Set<string>();

  private player: LavalinkPlayer | null = null;
  /**
   * The play Lavalink is on, as numbered by playEncoded(); events about any other one
   * are stale (see PLAY_TAG).
   */
  private playing: number | null = null;
  private plays = 0;
  /** The last track handed to Lavalink, replayed as is when looping. */
  private lastEncoded: string | null = null;
  private routes: Route[] = [];
  private routeIndex = 0;
  /** Where a track that broke while playing is taken up again, in milliseconds (0: from the start). */
  private resumeAt = 0;
  /** Whether the current track already had its second try at a stream address. */
  private retriedDirect = false;
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
    },
    /** How a track is loaded; the self-test puts its own in place of Lavalink and yt-dlp. */
    private readonly load: typeof loadVia = loadVia
  ) {}

  get channelId() {
    return this.player?.voiceChannelId ?? null;
  }

  get paused() {
    return this.player?.paused ?? false;
  }

  get isDestroyed() {
    return this.destroyed;
  }

  /** Seconds played in the current track. */
  get position() {
    return this.current ? Math.floor((this.player?.position ?? 0) / 1000) : 0;
  }

  /** Whether `player` is the Lavalink player this object drives (and not one from before a /stop). */
  owns(player: LavalinkPlayer) {
    return this.player === player;
  }

  async connect(channel: VoiceBasedChannel) {
    // Right after a /stop, the previous player of this server may still be closing and
    // Ditto still leaving the channel: wait for both (a few seconds at most), or the
    // new player would be closed along with the old one.
    await Promise.race([leaving.get(this.guild.id), new Promise((r) => setTimeout(r, 8000))]);
    if (this.destroyed) throw new Error('player closed');
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

  /** Adds tracks (at the front with `next`); starts playing if nothing is. Returns the queue position of the first one (0 = playing now). */
  async enqueue(tracks: Track[], next = false) {
    this.clearIdle();
    const wasPlaying = !!this.current;
    if (next) this.queue.unshift(...tracks);
    else this.queue.push(...tracks);
    if (!wasPlaying) {
      await this.advance();
      return 0;
    }
    this.queueChanged();
    return next ? 1 : this.queue.length - tracks.length + 1;
  }

  /** Lavalink reports the end of a track (finished, stopped, or failed to load). */
  onEnded(play: number | null) {
    if (play !== null && play !== this.playing) return; // a track we already moved on from
    void this.advance();
  }

  /** Lavalink reports that the playing track broke: try the next route before giving up. */
  onFailed(play: number | null, message: string) {
    if (!this.current || (play !== null && play !== this.playing)) return;
    const track = this.current;
    const failed = this.routes[this.routeIndex];
    log.warn('music', `${this.guild.name}: ${track.title} failed via ${failed}: ${message}`);
    // Whatever plays it next picks up where it broke, not from the start (a few seconds in, there is nothing to pick up).
    const at = this.player?.position ?? 0;
    this.resumeAt = !track.live && at > 5000 ? at : 0;
    this.playing = null; // the end event of the broken track must not advance the queue
    if (failed === 'direct') {
      forgetDirect(track.url);
      // A stream address can go stale in the middle of a track: a fresh one gets one try before the other routes.
      if (!this.retriedDirect) {
        this.retriedDirect = true;
        void this.start(track, new Error(message));
        return;
      }
    }
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
      if (previous) {
        this.history.push(previous);
        if (this.history.length > HISTORY) this.history.shift();
      }
    }
    this.playing = null;
    this.resumeAt = 0;
    this.retriedDirect = false;
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
      this.clearIdle();
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
      if (this.current !== next) return; // skipped in the meantime: the routes now belong to another track
      this.routeIndex++; // what was prepared no longer plays: carry on with the other routes
      return this.start(next);
    }
    try {
      await ensurePlayable(next);
    } catch (err) {
      if (this.destroyed || this.current !== next) return;
      return this.giveUp(next, err as Error);
    }
    if (this.destroyed || this.current !== next) return; // skipped while it was being matched
    this.routes = routesFor(next);
    this.routeIndex = 0;
    await this.start(next);
  }

  /** Hands an already loaded track to Lavalink. */
  private async playEncoded(track: Track, encoded: string) {
    if (!this.player || this.current !== track) return false;
    try {
      const play = ++this.plays;
      this.playing = play;
      this.lastEncoded = encoded;
      await this.player.play({
        track: { encoded, requester: track.requesterId, userData: { [PLAY_TAG]: play } },
        volume: this.volume,
        ...(this.resumeAt ? { position: this.resumeAt } : {}),
      });
      this.resumeAt = 0;
      if (!this.announced) {
        this.announced = true;
        this.hooks.onTrackStart(this);
      }
      this.prepareNext();
      return true;
    } catch {
      this.playing = null;
      return false;
    }
  }

  /** Loads the next track in the background, and looks up the one after (downloads stay on demand). */
  private prepareNext() {
    if (this.queue[1]) warm(this.queue[1]);
    const next = this.loop === 'track' ? null : this.queue[0];
    if (!next || this.prepared?.track === next) return;
    void (async () => {
      await ensurePlayable(next);
      const route = routesFor(next).find((r) => r !== 'download');
      if (!route) return;
      const { encoded } = await this.load(route, next);
      if (this.queue[0] === next) this.prepared = { track: next, route, encoded };
    })().catch(() => {});
  }

  /** Plays `track` from the current route onwards. */
  private async start(track: Track, lastError?: Error) {
    let error = lastError;
    // A track skipped or stopped while one of its routes was loading leaves at once,
    // without touching the routes (they now belong to the track that replaced it) and
    // without being given up on, which would take that other track down with it.
    const gone = () => this.destroyed || this.current !== track;
    while (this.routeIndex < this.routes.length) {
      if (gone()) return;
      const route = this.routes[this.routeIndex];
      try {
        const { encoded, file } = await this.load(route, track);
        if (gone() || !this.player) return;
        this.dropTempFile();
        this.tempFile = file ?? null;
        if (await this.playEncoded(track, encoded)) return;
        throw new Error('Lavalink refused to play it');
      } catch (err) {
        if (gone()) return;
        error = err as Error;
        log.warn('music', `${this.guild.name}: ${track.title} could not load via ${route}: ${error.message}`);
        this.routeIndex++;
      }
    }
    if (gone()) return;
    this.giveUp(track, error ?? new Error('no route'));
  }

  private giveUp(track: Track, error: Error) {
    this.hooks.onError(this, track, error instanceof UserError ? error : new UserError('This track could not be played.'));
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
    if (this.loop === 'track' && this.current) {
      this.history.push(this.current);
      this.current = null;
    }
    if (this.playing !== null) void this.player?.stopPlaying(false, false).catch(() => {});
    else void this.advance(); // still loading: move on directly
  }

  /** Back to the start of the track, or — in its first seconds — to the previous one. */
  async previous(): Promise<'previous' | 'restart'> {
    const last = this.history.at(-1);
    if (!this.current || !last || this.position > 5) {
      if (this.current && !this.current.live) await this.seek(0);
      return 'restart';
    }
    this.history.pop();
    this.queue.unshift(this.current);
    this.current = null; // advance() must not push it to the history again
    this.queue.unshift(last);
    this.prepared = null;
    if (this.playing !== null) {
      this.playing = null;
      await this.player?.stopPlaying(false, false).catch(() => {});
    }
    await this.advance();
    return 'previous';
  }

  pause() {
    if (!this.paused) void this.player?.pause().catch(() => {});
  }

  resume() {
    if (this.paused) void this.player?.resume().catch(() => {});
  }

  setVolume(level: number) {
    if (!Number.isFinite(level)) return;
    this.volume = Math.max(0, Math.min(100, Math.round(level)));
    void this.player?.setVolume(this.volume).catch(() => {});
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
    this.playing = null;
    this.dropTempFile();
    const player = this.player;
    this.player = null;
    if (player && !fromLavalink) {
      const id = this.guild.id;
      const gone: Promise<unknown> = player
        .destroy('stopped')
        .catch(() => {})
        .then(() => outOfVoice(this.guild))
        .finally(() => {
          if (leaving.get(id) === gone) leaving.delete(id);
        });
      leaving.set(id, gone);
    }
    this.hooks.onDestroy(this);
  }
}
