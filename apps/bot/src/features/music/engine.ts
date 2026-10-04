import { Events, type Client } from 'discord.js';
import { LavalinkManager, type Player } from 'lavalink-client';
import { log } from '../../core/log.js';
import { activeNode, loadTracks, startLavalink, type LoadResult, type NodeConfig } from './lavalink.js';
import { UserError } from './search.js';

/** Glue between Ditto's players and the Lavalink node. */
export interface EngineHooks {
  isIdle(): boolean;
  /** A track finished, was stopped or failed to load (not when replaced by another one). */
  onTrackEnd(guildId: string, play: number | null): void;
  /** A track broke while playing (Lavalink sends the end event right after). */
  onTrackError(guildId: string, play: number | null, message: string): void;
  /** Lavalink dropped a player (kicked from voice, node lost, or stopped by Ditto itself). */
  onPlayerGone(guildId: string, player: Player): void;
}

/**
 * Under this name each play carries its number in the track's user data, which Lavalink
 * hands back with every event about it. The encoded track cannot be used to tell which
 * play an event is about: it holds the position, so it comes back different from what
 * was sent as soon as some of it has played.
 */
export const PLAY_TAG = 'ditto';

type Tagged = { userData?: Record<string, unknown> | null } | null | undefined;

/** The number of the play an event is about, or null when it carries none. */
function playOf(...tracks: Tagged[]) {
  for (const t of tracks) {
    const n = t?.userData?.[PLAY_TAG];
    if (typeof n === 'number') return n;
  }
  return null;
}

let manager: LavalinkManager | null = null;
let node: NodeConfig | null = null;
let ready = false;

export function initEngine(client: Client, hooks: EngineHooks) {
  client.on('raw', (packet) => {
    void manager?.sendRawData(packet);
  });

  client.once(Events.ClientReady, async (c) => {
    try {
      node = await startLavalink(hooks.isIdle);
      manager = new LavalinkManager({
        nodes: [
          {
            id: 'ditto',
            host: node.host,
            port: node.port,
            authorization: node.password,
            secure: node.secure,
            retryAmount: 10_000,
            retryDelay: 5000,
          },
        ],
        sendToShard: (guildId, payload) => c.guilds.cache.get(guildId)?.shard?.send(payload),
        client: { id: c.user.id, username: c.user.username },
        autoSkip: false,
        playerOptions: {
          onDisconnect: { destroyPlayer: true },
          clientBasedPositionUpdateInterval: 500,
        },
      });

      // lavalink-client keeps a queue of its own, which Ditto leaves empty (it has its own):
      // the end of a track therefore arrives as « queueEnd ». « trackEnd » only comes when
      // that queue has something left — listening to both keeps Ditto's queue moving either way.
      const ended = (player: Player, track: Tagged, payload: { type: string; reason?: string; track?: Tagged }) => {
        if (payload.type !== 'TrackEndEvent' || payload.reason === 'replaced') return;
        hooks.onTrackEnd(player.guildId, playOf(payload.track, track));
      };
      manager.on('trackEnd', ended);
      manager.on('queueEnd', ended);
      manager.on('trackStuck', (player, track, payload) => {
        hooks.onTrackError(player.guildId, playOf(payload.track, track), 'track stuck');
      });
      manager.on('trackError', (player, track, payload) => {
        hooks.onTrackError(player.guildId, playOf(payload.track, track), payload.exception?.message ?? 'playback error');
      });
      manager.on('playerDestroy', (player) => hooks.onPlayerGone(player.guildId, player));
      manager.nodeManager.on('error', (_n, err) => log.warn('music', `Lavalink: ${err.message}`));

      await manager.init({ id: c.user.id, username: c.user.username });
      ready = true;
      log.info('music', 'connected to Lavalink');
    } catch (err) {
      log.error('music', 'music is unavailable, Lavalink could not start:', (err as Error).message);
    }
  });
}

/** For the dashboard: whether music works, and the Lavalink version. */
export function musicStatus() {
  return { ready, node: node ? `${node.host}:${node.port}` : null };
}

export function lavalink(): LavalinkManager {
  if (!manager || !ready) {
    throw new UserError('Music is still starting — try again in a minute.');
  }
  return manager;
}

export type LavalinkPlayer = Player;

/** Asks Lavalink to load an address (web page, direct media URL or local file) and returns the first track. */
export async function loadEncoded(identifier: string): Promise<{ encoded: string | null; error: string | null }> {
  if (!activeNode()) throw new UserError('Music is still starting — try again in a minute.');
  let r: LoadResult | null;
  try {
    r = await loadTracks(identifier);
  } catch (err) {
    return { encoded: null, error: (err as Error).message };
  }
  if (!r) return { encoded: null, error: 'Lavalink is not running' };
  if (r.loadType === 'track') return { encoded: r.data.encoded, error: null };
  if (r.loadType === 'search') return { encoded: r.data[0]?.encoded ?? null, error: null };
  if (r.loadType === 'playlist') return { encoded: r.data.tracks?.[0]?.encoded ?? null, error: null };
  if (r.loadType === 'error') return { encoded: null, error: r.data?.message ?? 'load error' };
  return { encoded: null, error: 'nothing found' };
}
