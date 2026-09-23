import { Events, type Client, type VoiceState } from 'discord.js';
import { getConfig } from '../../core/config.js';
import { log } from '../../core/log.js';
import { logTo } from '../../core/logs.js';

/** Journal vocal + AFK automatique (sourd depuis X minutes → salon AFK). */
const afkTimers = new Map<string, NodeJS.Timeout>();

function voiceLog(oldState: VoiceState, newState: VoiceState) {
  const member = newState.member;
  if (!member || member.user.bot || !getConfig(newState.guild.id).voiceLog) return;
  const name = `**${member.user.username}**`;
  if (!oldState.channelId && newState.channelId) logTo(newState.guild, `🟢 ${name} a rejoint ${newState.channel}`);
  else if (oldState.channelId && !newState.channelId) logTo(newState.guild, `🔴 ${name} a quitté ${oldState.channel}`);
  else if (oldState.channelId !== newState.channelId) {
    logTo(newState.guild, `🔁 ${name} : ${oldState.channel} → ${newState.channel}`);
  }
}

function autoAfk(newState: VoiceState) {
  const member = newState.member;
  if (!member || member.user.bot) return;
  const key = `${newState.guild.id}:${member.id}`;
  clearTimeout(afkTimers.get(key));
  afkTimers.delete(key);

  const afk = newState.guild.afkChannelId;
  const minutes = getConfig(newState.guild.id).afkIdleMinutes;
  if (!afk || minutes <= 0 || !newState.channelId || newState.channelId === afk || !newState.selfDeaf) return;

  const channelId = newState.channelId;
  afkTimers.set(
    key,
    setTimeout(() => {
      afkTimers.delete(key);
      if (!member.voice.selfDeaf || member.voice.channelId !== channelId) return;
      member.voice
        .setChannel(afk, 'Sourd depuis trop longtemps')
        .then(() => logTo(newState.guild, `💤 **${member.user.username}** envoyé en AFK (sourd depuis ${minutes} min)`))
        .catch((err) => log.warn('afk', err.message));
    }, minutes * 60_000)
  );
}

export function initPresence(client: Client) {
  client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    voiceLog(oldState, newState);
    autoAfk(newState);
  });
}
