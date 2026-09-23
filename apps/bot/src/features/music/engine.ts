import { Events, type Client } from 'discord.js';
import { LavalinkManager, type Player } from 'lavalink-client';
import { log } from '../../core/log.js';
import { activeNode, startLavalink, type NodeConfig } from './lavalink.js';
import { UserError } from './search.js';

/** Glue between Ditto's players and the Lavalink node. */
export interface EngineHooks {
  isIdle(): boolean;
  /** A track finished, was stopped or failed to load (not when replaced by another one). */
  onTrackEnd(guildId: string, encoded: string | null): void;
  /** A track broke while playing (Lavalink sends the end event right after). */
  onTrackError(guildId: string, encoded: string | null, message: string): void;
  /** Lavalink dropped the player (kicked from voice, node lost…). */
  onPlayerGone(guildId: string): void;
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

      manager.on('trackEnd', (player, track, payload) => {
        if (payload.reason !== 'replaced') hooks.onTrackEnd(player.guildId, payload.track?.encoded ?? track?.encoded ?? null);
      });
      manager.on('trackStuck', (player, track) => {
        hooks.onTrackError(player.guildId, track?.encoded ?? null, 'track stuck');
      });
      manager.on('trackError', (player, track, payload) => {
        hooks.onTrackError(player.guildId, track?.encoded ?? null, payload.exception?.message ?? 'playback error');
      });
      manager.on('playerDestroy', (player) => hooks.onPlayerGone(player.guildId));
      manager.nodeManager.on('error', (_n, err) => log.warn('music', `Lavalink: ${err.message}`));

      await manager.init({ id: c.user.id, username: c.user.username });
      ready = true;
      log.info('music', 'connected to Lavalink');
    } catch (err) {
      log.error('music', 'music is unavailable, Lavalink could not start:', (err as Error).message);
    }
  });
}

export function lavalink(): LavalinkManager {
  if (!manager || !ready) {
    throw new UserError('Music is still starting — try again in a minute.', 'La musique démarre encore, réessaie dans une minute.');
  }
  return manager;
}

export type LavalinkPlayer = Player;

interface LoadResult {
  loadType: 'track' | 'playlist' | 'search' | 'empty' | 'error';
  data: any;
}

/** Asks Lavalink to load an address (web page, direct media URL or local file) and returns the first track. */
export async function loadEncoded(identifier: string): Promise<{ encoded: string | null; error: string | null }> {
  const node = activeNode();
  if (!node) throw new UserError('Music is still starting — try again in a minute.', 'La musique démarre encore, réessaie dans une minute.');
  const scheme = node.secure ? 'https' : 'http';
  const res = await fetch(`${scheme}://${node.host}:${node.port}/v4/loadtracks?identifier=${encodeURIComponent(identifier)}`, {
    headers: { Authorization: node.password },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) return { encoded: null, error: `HTTP ${res.status}` };
  const r = (await res.json()) as LoadResult;
  if (r.loadType === 'track') return { encoded: r.data.encoded, error: null };
  if (r.loadType === 'search') return { encoded: r.data[0]?.encoded ?? null, error: null };
  if (r.loadType === 'playlist') return { encoded: r.data.tracks?.[0]?.encoded ?? null, error: null };
  if (r.loadType === 'error') return { encoded: null, error: r.data?.message ?? 'load error' };
  return { encoded: null, error: 'nothing found' };
}
