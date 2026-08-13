# Ditto

Discord bot for voice-channel moderation and music playback.

**GitHub:** [da0t-exe/Ditto](https://github.com/da0t-exe/Ditto)

## Features

### Voice
- **`/move`** — move every member from one voice channel to another
- **`/stick` / `/unstick` / `/stick-status`** — lock a voice channel; members who leave are pulled back
- **`/wake-up`** — bounce a user through random voice channels, then drop them in a destination
- **`/dm-all`** — DM members of this server (Administrator only, max 100, 24h cooldown)

Discord can move someone who is already in voice. It cannot force a disconnected user to join a voice channel.

### Music
`/play` `/playlist` `/skip` `/stop` `/pause` `/resume` `/queue` `/nowplaying` `/volume` `/settings`

- Playback is **YouTube only**. Spotify, Apple Music, Deezer, and song.link links are resolved to YouTube.
- The bot joins the requester’s voice channel.
- It leaves on `/stop`, or when no humans remain in the channel.
- Skip/stop: the current track requester skips instantly; otherwise a majority vote in the bot’s voice channel.

Music commands are public. `/settings` and voice-moderation commands need **Move Members**.

## Requirements

- [Node.js](https://nodejs.org/) 18+
- A Discord application with the bot invited to your server
- **FFmpeg** on the host (Pterodactyl Discord eggs usually include it). Otherwise set `FFMPEG_PATH`.

Bot permissions: **Connect**, **Speak**, **Move Members**, **View Channels**, **Send Messages**.

Privileged intents: **Server Members**, **Voice States**.

## Setup

1. Create an application at [Discord Developer Portal](https://discord.com/developers/applications) named **Ditto**.
2. Bot tab → reset/copy the token. Enable **Server Members Intent**.
3. OAuth2 → URL Generator → scopes `bot` and `applications.commands` → invite the bot.
4. Copy the **Application ID** (`CLIENT_ID`) and your server ID (`GUILD_IDS`).

```bash
npm install
cp .env.example .env
```

```env
BOT_TOKEN=your_bot_token
CLIENT_ID=your_application_id
GUILD_IDS=your_guild_id
```

Optional: `FFMPEG_PATH`, `EMOJI_YOUTUBE`, `EMOJI_YOUTUBE_MUSIC`.

## Run

Register slash commands once (or after you change them):

```bash
npm run deploy
```

Start the bot:

```bash
npm start
```

You should see `Logged in as Ditto#XXXX` and `engine=yt-dlp-pipe+ffmpeg-pcm`.

On **Pterodactyl**, the start command must stay `npm start`. `npm run deploy` registers commands and exits 0, which the panel treats as a crash — run deploy, then Start again.

## Project layout

```
src/index.js     Bot, /move, /stick, /wake-up, /dm-all
src/deploy.js    Slash command registration
src/music.js     Music commands, embeds, settings
src/player.js    yt-dlp + FFmpeg playback
src/resolve.js   YouTube / Spotify / Deezer / playlists
```

## Contributors

- [da0t-exe](https://github.com/da0t-exe)
- [cursoragent](https://github.com/cursoragent) (Cursor Agent)
