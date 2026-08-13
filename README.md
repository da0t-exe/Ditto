<p align="center">
  <img src="./assets/Ditto.jpg" alt="Ditto avatar" width="160" height="160">
</p>

<h1 align="center">Ditto</h1>

<p align="center">
  A Discord bot for voice-channel moderation and music playback.
</p>

---

## Table of Contents

- [Features](#features)
  - [Voice Moderation](#voice-moderation)
  - [Music](#music)
- [Requirements](#requirements)
- [Installation](#installation)
- [Configuration](#configuration)
- [Running the Bot](#running-the-bot)
- [Project Layout](#project-layout)
- [Deploying on Pterodactyl](#deploying-on-pterodactyl)
- [License](#license)
- [Contributors](#contributors)

---

## Features

### Voice Moderation

| Command | Description |
|---|---|
| `/move` | Move every member from one voice channel to another. |
| `/stick` / `/unstick` / `/stick-status` | Lock a voice channel — members who try to leave are automatically pulled back in. |
| `/wake-up` | Bounce a user through a series of random voice channels before dropping them in a final destination. |
| `/dm-all` | DM every member of the server. Administrator only, capped at 100 recipients, with a 24-hour cooldown. |

> **Note:** Discord's API lets a bot move a member who is *already* connected to voice, but it cannot force a disconnected user to join a voice channel.

### Music

`/play` · `/playlist` · `/skip` · `/stop` · `/pause` · `/resume` · `/queue` · `/nowplaying` · `/volume` · `/settings`

- Playback runs through **YouTube only**. Links from Spotify, Apple Music, Deezer, and song.link are automatically resolved to a matching YouTube source.
- The bot joins the voice channel of whoever issued the command.
- It automatically leaves when `/stop` is used, or when no human members remain in the channel.
- Skipping works two ways: the person who requested the current track can skip instantly, otherwise a majority vote among listeners in the bot's channel is required.

Music commands are available to everyone. Voice-moderation commands and `/settings` require the **Move Members** permission.

---

## Requirements

Make sure you have the following before installing:

- **[Node.js](https://nodejs.org/)** version 18 or later
- A **Discord application** with the bot already invited to your server
- **FFmpeg** installed on the host machine (most Pterodactyl Discord bot eggs already include it — otherwise, point to your binary with the `FFMPEG_PATH` environment variable)

The bot also needs the following **permissions** when invited:
`Connect`, `Speak`, `Move Members`, `View Channels`, `Send Messages`

And these **privileged intents** enabled in the Developer Portal:
`Server Members Intent`, `Voice States`

---

## Installation

### 1. Create your Discord application

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) and create a new application named **Ditto** (or whatever you'd like to call it).
2. Open the **Bot** tab, reset and copy the bot **token**, then enable **Server Members Intent**.
3. Open **OAuth2 → URL Generator**, select the `bot` and `applications.commands` scopes, choose the permissions listed above, and use the generated link to invite the bot to your server.
4. Copy your application's **Application ID** (this will be `CLIENT_ID`) and your **server (guild) ID** (this will be `GUILD_IDS`).

### 2. Clone the repository

```bash
git clone https://github.com/da0t-exe/Ditto.git
cd Ditto
```

### 3. Install dependencies

```bash
npm install
```

---

## Configuration

Copy the example environment file and fill it in with your own values:

```bash
cp .env.example .env
```

```env
BOT_TOKEN=your_bot_token
CLIENT_ID=your_application_id
GUILD_IDS=your_guild_id
```

Optional variables you can also set:

- `FFMPEG_PATH` — path to your FFmpeg binary, if it isn't available on the system `PATH`
- `EMOJI_YOUTUBE` — custom emoji used for YouTube sources
- `EMOJI_YOUTUBE_MUSIC` — custom emoji used for YouTube Music sources

---

## Running the Bot

**Step 1 — Register the slash commands.** This only needs to be run once, or again whenever you add/change a command:

```bash
npm run deploy
```

**Step 2 — Start the bot:**

```bash
npm start
```

If everything is configured correctly, you should see something like:

```
Logged in as YourBotName#XXXX
engine=yt-dlp-pipe+ffmpeg-pcm
```

> The bot's display name comes from whatever you named your application in the Discord Developer Portal — it doesn't have to be "Ditto". Rename it there, and it'll show up under your chosen name instead.

---

## Project Layout

```
src/index.js     Bot client, /move, /stick, /wake-up, /dm-all
src/deploy.js    Slash command registration
src/music.js     Music commands, embeds, and settings
src/player.js    yt-dlp + FFmpeg playback engine
src/resolve.js   YouTube / Spotify / Deezer link and playlist resolution
```

---

## Deploying on Pterodactyl

If you're hosting Ditto on a **Pterodactyl** panel:

- Keep the panel's **start command** set to `npm start`.
- `npm run deploy` registers the slash commands and then exits with code 0 — Pterodactyl interprets that clean exit as a crash. Run `npm run deploy` manually from the console, then start the server normally with `npm start`.

---

## License

This project is licensed under the [MIT License](./LICENSE).

---

## Contributors

- [da0t-exe](https://github.com/da0t-exe)
- [cursoragent](https://github.com/cursoragent) (Cursor Agent)

