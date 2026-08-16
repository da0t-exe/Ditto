require('dotenv').config();
const { REST, Routes, SlashCommandBuilder, ChannelType } = require('discord.js');

const commands = [
  new SlashCommandBuilder()
    .setName('move')
    .setDescription('Moves all members of a voice channel to another one')
    .addChannelOption((opt) =>
      opt
        .setName('source')
        .setDescription('Source voice channel')
        .addChannelTypes(ChannelType.GuildVoice)
        .setRequired(true)
    )
    .addChannelOption((opt) =>
      opt
        .setName('destination')
        .setDescription('Destination voice channel')
        .addChannelTypes(ChannelType.GuildVoice)
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('wake-up')
    .setDescription('Moves a user through random voice channels to wake them up')
    .addUserOption((opt) => opt.setName('user').setDescription('User to wake up').setRequired(true))
    .addChannelOption((opt) =>
      opt
        .setName('channel')
        .setDescription('Final destination voice channel (optional)')
        .addChannelTypes(ChannelType.GuildVoice)
        .setRequired(false)
    )
    .addIntegerOption((opt) =>
      opt
        .setName('moves')
        .setDescription('Number of moves (default: 15)')
        .setMinValue(1)
        .setMaxValue(50)
        .setRequired(false)
    )
    .addNumberOption((opt) =>
      opt
        .setName('interval')
        .setDescription('Time between moves in ms (default: 400, minimum: 1)')
        .setMinValue(1)
        .setMaxValue(5000)
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('dm-all')
    .setDescription('Sends a private message to every member of THIS server')
    .addStringOption((opt) =>
      opt
        .setName('message')
        .setDescription('The message to send privately')
        .setRequired(true)
        .setMaxLength(2000)
    )
    .addBooleanOption((opt) =>
      opt
        .setName('exclude_bots')
        .setDescription('Do not send to bots (default: yes)')
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('stick')
    .setDescription('Locks a channel: members who leave are automatically brought back')
    .addChannelOption((opt) =>
      opt
        .setName('channel')
        .setDescription('Voice channel to lock')
        .addChannelTypes(ChannelType.GuildVoice)
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('unstick')
    .setDescription('Unlocks a channel (stops the automatic moving back)')
    .addChannelOption((opt) =>
      opt
        .setName('channel')
        .setDescription('Voice channel to unlock')
        .addChannelTypes(ChannelType.GuildVoice)
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('stick-status')
    .setDescription('Shows the currently locked channels'),

  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play a track (YouTube / Spotify / Apple / Deezer / search)')
    .addStringOption((opt) =>
      opt
        .setName('query')
        .setDescription('Song URL or search text')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('playlist')
    .setDescription('Play a playlist / album (URL or YouTube playlist search)')
    .addStringOption((opt) =>
      opt
        .setName('query')
        .setDescription('Playlist/album URL, or search text (e.g. daft punk discovery)')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('skip')
    .setDescription('Skip the current track (requester, or half the voice channel)'),

  new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Stop playback (requester, or half the voice channel)'),

  new SlashCommandBuilder()
    .setName('pause')
    .setDescription('Pause the current track'),

  new SlashCommandBuilder()
    .setName('resume')
    .setDescription('Resume the paused track'),

  new SlashCommandBuilder()
    .setName('queue')
    .setDescription('Show the music queue'),

  new SlashCommandBuilder()
    .setName('nowplaying')
    .setDescription('Show the currently playing track'),

  new SlashCommandBuilder()
    .setName('volume')
    .setDescription('Set the session volume (0-100)')
    .addIntegerOption((opt) =>
      opt
        .setName('level')
        .setDescription('Volume level')
        .setRequired(true)
        .setMinValue(0)
        .setMaxValue(100)
    ),

  new SlashCommandBuilder()
    .setName('settings')
    .setDescription('Configure music settings for this server (ephemeral)'),

  new SlashCommandBuilder()
    .setName('sudo')
    .setDescription('Override the last denied music command in this channel (Administrator)'),
].map((c) => c.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);

const guildIds = (process.env.GUILD_IDS || '')
  .split(',')
  .map((g) => g.trim())
  .filter(Boolean);

(async () => {
  try {
    // Global mode (if GUILD_IDS is empty)
    if (guildIds.length === 0) {
      console.log('Registering slash commands globally...');
      await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
      console.log('Global commands registered.');
      console.log('Discord may take a few minutes (sometimes up to 1h) to show new commands like /playlist.');
      console.log('Restart the bot in the Pterodactyl panel after deploy.');
      return;
    }

    // Instant mode: delete globals to avoid duplicates, then register on the GUILD_IDS servers.
    const globals = await rest.get(Routes.applicationCommands(process.env.CLIENT_ID));
    for (const cmd of globals) {
      await rest.delete(Routes.applicationCommand(process.env.CLIENT_ID, cmd.id));
      console.log(`Deleted global: ${cmd.name}`);
    }

    for (const guildId of guildIds) {
      await rest.put(
        Routes.applicationGuildCommands(process.env.CLIENT_ID, guildId),
        { body: commands }
      );
      console.log(`Commands instantly registered on server ${guildId}.`);
    }
    console.log('Done (instant mode).');
  } catch (err) {
    console.error(err);
  }
})();
