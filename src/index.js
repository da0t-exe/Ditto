require('dotenv').config();
const { Client, GatewayIntentBits, PermissionsBitField, EmbedBuilder } = require('discord.js');
const {
  handleMusicCommand,
  handleSettingsSelect,
  maybeLeaveIfEmpty,
  getFfmpegPath,
  logMusicEngine,
  warmMusic,
} = require('./music');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
  ],
});

// Locked channels: Map<channelId, Set<memberId>>
// Members in the Set are forced back into this channel.
// A member stays tracked until the channel is unlocked (/unstick),
// even after leaving voice completely.
const stickyChannels = new Map();

// /dm-all safeguards
const dmCooldowns = new Map(); // guildId -> timestamp (next allowed use)
const MAX_DMS = 100; // max sends per execution
const DM_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 1 day between sends

function getTrackedHome(memberId) {
  for (const [channelId, members] of stickyChannels) {
    if (members.has(memberId)) return channelId;
  }
  return null;
}

async function moveBack(member, channelId) {
  const lockedChannel = member.guild?.channels.cache.get(channelId);
  if (!lockedChannel) return;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await member.voice.setChannel(lockedChannel);
      console.log(`[stick] ${member.user.tag} moved back to ${lockedChannel.name}`);
      break;
    } catch (err) {
      const isRateLimit = err?.code === 429 || String(err?.message).toLowerCase().includes('rate limit');
      console.error(`[stick] failed ${member.user.tag} -> ${lockedChannel.name}: ${err.message}`);
      if (isRateLimit && attempt === 0) {
        await sleep(1500);
        continue;
      }
      break;
    }
  }
}

function canMoveMembers(interaction) {
  return interaction.memberPermissions?.has(PermissionsBitField.Flags.MoveMembers);
}

const MUSIC_PUBLIC_COMMANDS = new Set([
  'play',
  'playlist',
  'skip',
  'stop',
  'pause',
  'resume',
  'queue',
  'nowplaying',
  'volume',
  'sudo',
]);

client.once('clientReady', () => {
  console.log(`Logged in as ${client.user.tag}`);
  const ffmpeg = getFfmpegPath();
  console.log(ffmpeg ? `[music] FFmpeg: ${ffmpeg}` : '[music] FFmpeg not found yet — install on the host / Pterodactyl egg');
  logMusicEngine();
  warmMusic().catch(() => {});
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function shutdown() {
  console.log('Shutting down...');
  try {
    await client.destroy();
  } catch (_) {}
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

client.on('interactionCreate', async (interaction) => {
  try {
    if (await handleSettingsSelect(interaction)) return;
  } catch (err) {
    console.error('[settings] interaction error:', err);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: 'Settings UI error.', ephemeral: true }).catch(() => {});
    }
  }

  if (!interaction.isChatInputCommand()) return;

  // Music playback is open to everyone; Move Members stays required for /move /stick /wake-up /dm-all /settings
  if (!MUSIC_PUBLIC_COMMANDS.has(interaction.commandName) && !canMoveMembers(interaction)) {
    return interaction.reply({
      content: "You don't have the 'Move Members' permission to use this command.",
      ephemeral: true,
    });
  }

  const { commandName } = interaction;

  try {
    if (await handleMusicCommand(interaction)) return;
  } catch (err) {
    console.error(`[music] /${commandName} error:`, err);
    const payload = { content: `Music command failed: ${err.message}`, ephemeral: true };
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(payload).catch(() => {});
    } else {
      await interaction.reply(payload).catch(() => {});
    }
    return;
  }

  // ---------- /move ----------
  if (commandName === 'move') {
    const source = interaction.options.getChannel('source');
    const destination = interaction.options.getChannel('destination');

    await interaction.deferReply();

    if (!source || !source.isVoiceBased()) {
      return interaction.editReply('The source channel is not a voice channel.');
    }
    if (!destination || !destination.isVoiceBased()) {
      return interaction.editReply('The destination channel is not a voice channel.');
    }

    const membersToMove = [...source.members.values()];
    if (membersToMove.length === 0) {
      return interaction.editReply(`No members in ${source}.`);
    }

    let moved = 0;
    for (const member of membersToMove) {
      try {
        await member.voice.setChannel(destination);
        moved++;
      } catch (err) {
        console.error(`Failed to move ${member.user.tag}:`, err.message);
      }
    }

    return interaction.editReply(`${moved}/${membersToMove.length} member(s) moved from ${source} to ${destination}.`);
  }

  // ---------- /wake-up ----------
  if (commandName === 'wake-up') {
    const target = interaction.options.getUser('user');
    const finalChannel = interaction.options.getChannel('channel');
    const moves = interaction.options.getInteger('moves') ?? 15;
    const interval = interaction.options.getNumber('interval') ?? 400;

    const member =
      interaction.guild.members.cache.get(target.id) ??
      (await interaction.guild.members.fetch(target.id).catch(() => null));

    if (!member) {
      return interaction.reply({ content: 'This user is not on this server.', ephemeral: true });
    }

    if (!member.voice.channelId) {
      return interaction.reply({ content: `${target} is not in a voice channel.`, ephemeral: true });
    }

    const voiceChannels = [
      ...interaction.guild.channels.cache.filter(
        (c) =>
          c.isVoiceBased() &&
          c.id !== interaction.guild.afkChannelId &&
          c.permissionsFor(interaction.client.user)?.has(PermissionsBitField.Flags.Connect)
      ),
    ];

    if (voiceChannels.length < 2) {
      return interaction.reply({ content: "There aren't enough voice channels available.", ephemeral: true });
    }

    await interaction.deferReply();

    const channel = interaction.channel; // fixed reference for the summary send

    const makeProgressEmbed = (title, description, color) =>
      new EmbedBuilder().setTitle(title).setDescription(description).setColor(color);

    // Live tracking: a progress embed (the same message, updated)
    let progressEmbed = makeProgressEmbed(
      `Wake-up of ${target.username}`,
      'Starting...',
      0xf1c40f
    );
    await interaction.editReply({ embeds: [progressEmbed] }).catch(() => {});

    let moved = 0;
    let lastError = null;
    let lastProgressAt = Date.now();
    for (let i = 0; i < moves; i++) {
      if (!member.voice.channelId) break;
      const candidates = voiceChannels.filter(([id]) => id !== member.voice.channelId);
      if (candidates.length === 0) break;
      const randomChannel = candidates[Math.floor(Math.random() * candidates.length)][1];
      try {
        await member.voice.setChannel(randomChannel);
        moved++;
      } catch (err) {
        lastError = err.message;
        break;
      }

      const nowT = Date.now();
      if (nowT - lastProgressAt >= 2000) {
        lastProgressAt = nowT;
        progressEmbed = makeProgressEmbed(
          `Wake-up of ${target.username}`,
          `Move ${moved}/${moves}...\nChannel: ${randomChannel.name}`,
          0xf1c40f
        );
        await interaction.editReply({ embeds: [progressEmbed] }).catch(() => {});
      }

      if (i < moves - 1) await sleep(interval);
    }

    if (finalChannel && member.voice.channelId && finalChannel.id !== member.voice.channelId) {
      try {
        await member.voice.setChannel(finalChannel);
      } catch (err) {
        lastError = lastError ?? err.message;
      }
    }

    // Delete the tracking embed and create a new summary embed
    await interaction.deleteReply().catch(() => {});

    const destinationText = finalChannel ? ` and sent to ${finalChannel}` : '';
    const errorText = lastError ? `\nStopped after ${moved} move(s): ${lastError}` : '';
    const finalEmbed = makeProgressEmbed(
      lastError ? 'Wake-up interrupted' : 'Wake-up complete',
      `${target} was moved ${moved} time(s)${destinationText}.${errorText}`,
      lastError ? 0xe74c3c : 0x2ecc71
    );
    if (channel) {
      await channel.send({ embeds: [finalEmbed] }).catch((err) => {
        console.error(`[wake-up] could not send the summary: ${err.message}`);
      });
    } else {
      await interaction.followUp({ embeds: [finalEmbed] }).catch(() => {});
    }
  }

  // ---------- /dm-all ----------
  if (commandName === 'dm-all') {
    if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
      return interaction.reply({
        content: 'This command is restricted to members with a role that has the Administrator permission.',
        ephemeral: true,
      });
    }

    const messageText = interaction.options.getString('message', true);
    const excludeBots = interaction.options.getBoolean('exclude_bots') ?? true;

    const now = Date.now();
    const nextAllowed = dmCooldowns.get(interaction.guild.id) ?? 0;
    if (now < nextAllowed) {
      const remainingMin = Math.ceil((nextAllowed - now) / 60000);
      const hours = Math.floor(remainingMin / 60);
      const minutes = remainingMin % 60;
      return interaction.reply({
        content: `Command on cooldown. Try again in ${hours}h ${minutes}min.`,
        ephemeral: true,
      });
    }

    await interaction.deferReply();

    const channel = interaction.channel; // fixed reference for the summary send

    const makeEmbed = (title, description, color) =>
      new EmbedBuilder().setTitle(title).setDescription(description).setColor(color);

    let members;
    try {
      members = await interaction.guild.members.fetch();
    } catch (err) {
      await interaction.deleteReply().catch(() => {});
      const errEmbed = makeEmbed(
        'Error',
        `Could not fetch the member list: ${err.message}`,
        0xe74c3c
      );
      if (channel) {
        await channel.send({ embeds: [errEmbed] }).catch(() => {});
      }
      return;
    }

    if (excludeBots) members = members.filter((m) => !m.user.bot);

    // Live tracking: a progress embed (updated)
    let progressEmbed = makeEmbed(
      'Sending private messages',
      `Starting...\n${members.size} recipient(s)`,
      0xf1c40f
    );
    await interaction.editReply({ embeds: [progressEmbed] }).catch(() => {});

    let sent = 0;
    let failed = 0;
    let lastProgressAt = Date.now();
    for (const member of members.values()) {
      if (sent >= MAX_DMS) {
        console.log(`[dm-all] cap of ${MAX_DMS} DMs reached, sending interrupted.`);
        break;
      }
      try {
        await member.send(messageText);
        sent++;
      } catch {
        failed++;
      }
      await sleep(1100);

      const nowT = Date.now();
      if (nowT - lastProgressAt >= 3000) {
        lastProgressAt = nowT;
        progressEmbed = makeEmbed(
          'Sending private messages',
          `Sent: ${sent}\nFailed: ${failed}\nTotal: ${members.size}`,
          0xf1c40f
        );
        await interaction.editReply({ embeds: [progressEmbed] }).catch(() => {});
      }
    }

    dmCooldowns.set(interaction.guild.id, Date.now() + DM_COOLDOWN_MS);

    // Delete the tracking embed and create a new summary embed
    await interaction.deleteReply().catch(() => {});

    const capped = members.size > MAX_DMS ? ` (capped at ${MAX_DMS})` : '';
    const finalEmbed = makeEmbed(
      'Sending complete',
      `${sent} message(s) sent, ${failed} failed${capped}.\nNext /dm-all available in 24h.`,
      failed > 0 ? 0xf1c40f : 0x2ecc71
    );
    if (channel) {
      await channel.send({ embeds: [finalEmbed] }).catch(() => {});
    }
  }

  // ---------- /stick ----------
  if (commandName === 'stick') {
    const channel = interaction.options.getChannel('channel');

    const memberSet = new Set(channel.members.keys());
    stickyChannels.set(channel.id, memberSet);

    return interaction.reply(
      `${channel} is now locked. ${memberSet.size} member(s) currently present will be brought back automatically if they change channels.\n` +
        'Any new person who joins this channel will also be added automatically to the list.'
    );
  }

  // ---------- /unstick ----------
  if (commandName === 'unstick') {
    const channel = interaction.options.getChannel('channel');

    if (!stickyChannels.has(channel.id)) {
      return interaction.reply({ content: `${channel} is not locked.`, ephemeral: true });
    }

    stickyChannels.delete(channel.id);
    return interaction.reply(`${channel} has been unlocked.`);
  }

  // ---------- /stick-status ----------
  if (commandName === 'stick-status') {
    if (stickyChannels.size === 0) {
      return interaction.reply('No channel is currently locked.');
    }

    const lines = [...stickyChannels.entries()].map(([channelId, members]) => {
      const channel = interaction.guild.channels.cache.get(channelId);
      return `<#${channelId}> (${channel ? channel.name : 'deleted channel'}) — ${members.size} tracked member(s)`;
    });

    return interaction.reply(lines.join('\n'));
  }

  // Unhandled slash (e.g. /playlist registered but old bot files on host)
  console.warn(`[bot] unhandled command: /${commandName}`);
  return interaction.reply({
    content: `Command \`/${commandName}\` is registered but not handled by this bot version. Upload the latest src files and restart.`,
    ephemeral: true,
  }).catch(() => {});
});

// ---------- Voice lock (/stick) ----------
client.on('voiceStateUpdate', async (oldState, newState) => {
  // Music: leave when no humans remain in the bot's voice channel
  if (oldState.channelId && oldState.channelId !== newState.channelId && oldState.guild) {
    maybeLeaveIfEmpty(oldState.guild, oldState.channelId);
  }

  const member = newState.member;
  if (!member || member.user.bot) return;

  // Case 1: someone joins a locked channel -> add to the tracked list
  if (newState.channelId && stickyChannels.has(newState.channelId)) {
    stickyChannels.get(newState.channelId).add(member.id);
  }

  // Case 2: someone leaves a locked channel for ANOTHER voice channel -> bring them back.
  // No dependency on the Set snapshot: any member who leaves a locked channel
  // for another channel is brought back.
  const lockedId = oldState.channelId;
  if (
    lockedId &&
    stickyChannels.has(lockedId) &&
    newState.channelId &&
    newState.channelId !== lockedId
  ) {
    await moveBack(member, lockedId);
    return;
  }

  // Case 3: a tracked member (present in the locked channel, even after a full
  // disconnect) comes back into any voice channel != their locked channel
  // -> bring them back. Tracking lasts until /unstick.
  const trackedHome = getTrackedHome(member.id);
  if (newState.channelId && trackedHome && newState.channelId !== trackedHome) {
    await moveBack(member, trackedHome);
  }
});

client.login(process.env.BOT_TOKEN);
