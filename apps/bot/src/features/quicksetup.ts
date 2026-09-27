import { ChannelType, OverwriteType, PermissionFlagsBits, type Guild } from 'discord.js';
import { getConfig, updateConfig } from '../core/config.js';
import { log } from '../core/log.js';
import { pool } from '../core/ui.js';
import { ensurePanel } from './captcha/index.js';

const P = PermissionFlagsBits;

export interface QuickSetupResult {
  created: string[];
  hidden: number;
  failed: number;
}

/** What the one-click setup needs from Ditto's own role, and is missing. */
export function quickSetupMissing(guild: Guild) {
  const me = guild.members.me;
  const need = { 'Manage Roles': P.ManageRoles, 'Manage Channels': P.ManageChannels };
  return Object.entries(need)
    .filter(([, flag]) => !me?.permissions.has(flag))
    .map(([name]) => name);
}

/**
 * Sets the captcha up in one go, without touching what already works:
 * - an « Unverified » role for newcomers, and a #verify channel only they see;
 * - every other channel hidden from that role (an extra permission line, nothing else changes);
 * - a private #ditto-logs channel for staff;
 * - the Verify panel posted.
 *
 * Deleting the Unverified role undoes all of it at once.
 */
export async function quickSetup(guild: Guild): Promise<QuickSetupResult> {
  const cfg = getConfig(guild.id);
  const me = guild.members.me!;
  const created: string[] = [];

  let pending = cfg.pendingRole ? guild.roles.cache.get(cfg.pendingRole) : undefined;
  if (!pending) {
    pending = await guild.roles.create({ name: 'Unverified', permissions: [], reason: 'Ditto quick setup: newcomers wait here' });
    created.push(`role ${pending}`);
  }

  let verify = cfg.verifyChannel ? guild.channels.cache.get(cfg.verifyChannel) : undefined;
  if (!verify) {
    verify = await guild.channels.create({
      name: 'verify',
      type: ChannelType.GuildText,
      position: 0,
      reason: 'Ditto quick setup: the captcha lives here',
      permissionOverwrites: [
        { id: guild.roles.everyone.id, type: OverwriteType.Role, deny: [P.ViewChannel] },
        {
          id: pending.id,
          type: OverwriteType.Role,
          allow: [P.ViewChannel, P.ReadMessageHistory],
          deny: [P.SendMessages, P.AddReactions, P.CreatePublicThreads, P.CreatePrivateThreads],
        },
        { id: me.id, type: OverwriteType.Member, allow: [P.ViewChannel, P.SendMessages, P.EmbedLinks, P.AttachFiles, P.ReadMessageHistory] },
      ],
    });
    created.push(`channel ${verify}`);
  }

  let logs = cfg.logChannel ? guild.channels.cache.get(cfg.logChannel) : undefined;
  if (!logs) {
    logs = await guild.channels.create({
      name: 'ditto-logs',
      type: ChannelType.GuildText,
      reason: 'Ditto quick setup: joins, captcha and moderation logs',
      permissionOverwrites: [
        { id: guild.roles.everyone.id, type: OverwriteType.Role, deny: [P.ViewChannel] },
        ...cfg.staffRoles
          .filter((id) => guild.roles.cache.has(id))
          .map((id) => ({ id, type: OverwriteType.Role, allow: [P.ViewChannel, P.ReadMessageHistory] })),
        { id: me.id, type: OverwriteType.Member, allow: [P.ViewChannel, P.SendMessages, P.EmbedLinks, P.ReadMessageHistory] },
      ],
    });
    created.push(`channel ${logs}`);
  }

  updateConfig(guild.id, { pendingRole: pending.id, verifyChannel: verify.id, logChannel: logs.id });

  // Newcomers see nothing but #verify until they pass.
  const channels = [...guild.channels.cache.values()].filter(
    (c) =>
      c.id !== verify!.id && !c.isThread() && 'permissionOverwrites' in c && !c.permissionOverwrites.cache.get(pending!.id)?.deny.has(P.ViewChannel)
  );
  let hidden = 0;
  let failed = 0;
  await pool(channels, 3, async (c) => {
    try {
      if (!('permissionOverwrites' in c)) return;
      await c.permissionOverwrites.edit(pending!, { ViewChannel: false }, { reason: 'Ditto quick setup: hidden until the captcha is passed' });
      hidden++;
    } catch (err) {
      failed++;
      log.warn('setup', `${guild.name}: could not hide #${c.name}: ${(err as Error).message}`);
    }
  });

  await ensurePanel(guild).catch(() => {});
  return { created, hidden, failed };
}
