<div align="center">

<img src="./assets/ditto.png" width="112" alt="Ditto" />

# Ditto

Voice tools, music and a picture captcha for Discord.

<a href="https://github.com/da0t-exe/Ditto/releases"><img src="./assets/badges/version.svg" alt="version 0.4.0" /></a>
<img src="./assets/badges/node.svg" alt="node 20+" />
<img src="./assets/badges/discordjs.svg" alt="discord.js 14" />
<a href="LICENSE"><img src="./assets/badges/license.svg" alt="license MIT" /></a>

</div>

Ditto looks after the voice side of a server and the door in front of it: a
picture captcha for newcomers, music for everyone, and voice tools for
moderators. It speaks **English and French**, and everything is set up from
Discord with `/setup`.

## Features

### 🔐 Picture captcha

Newcomers only see a verification channel with a **Verify me** button. It
opens a private challenge in the style of reCAPTCHA: one photo cut into a 4×4
grid, the instruction drawn on the picture — *"Select all squares with BUSES"* —
and sixteen buttons laid out like the squares.

- Photos come from [Open Images](https://storage.googleapis.com/openimages/web/index.html)
  with the exact position of every object: traffic lights, bicycles, buses,
  cars, motorcycles, fire hydrants, stop signs, boats, palm trees, street
  lights and stairs. No drawings.
- Squares the object clearly fills must be ticked; squares it only brushes, or
  that show a look-alike (a taxi when asked for cars), are accepted either way.
- **No challenge is served twice.** Each one is fingerprinted, the least shown
  photos come first, and every photo is zoomed, shifted, mirrored and tinted at
  random.
- Three misses mean a 10-minute Discord **timeout**. Nobody is kicked.
- **Quarantine:** members brought in by a member-pushing bot are recognised
  from Discord's join source and get a quarantine role instead.

### 🎵 Music

- `/play` takes a song name — with suggestions as you type — or a link.
  Searches only return **songs**, from YouTube Music.
- Links from **YouTube** (Shorts and YouTube Music included), **SoundCloud**,
  **Bandcamp**, **TikTok**, **Twitch**, **X** and **Instagram** play directly.
  **Spotify**, **Apple Music**, **Deezer** and **Tidal** tracks are matched on
  YouTube Music; Spotify, Apple Music and Deezer albums and playlists too.
- A player message with buttons — pause, skip, stop, loop, queue — and a
  progress bar. Queue, volume, loop, shuffle and lyrics commands.
- Whoever queued a track can skip it; otherwise half the listeners have to
  agree. Ditto leaves when the queue ends or the channel empties.

### 🔊 Voice

- Move, gather, split, disconnect and "shake" members across channels.
- **Locks:** members of a locked channel are pulled back if they leave it, for
  as long as the lock lasts. Staff are never pulled back.
- **Rooms:** the first person in an empty room owns it and can customise it;
  when the last person leaves, it goes back to its original name, limit and
  permissions.
- Members deafened for 10 minutes go to the AFK channel, and joins, leaves and
  moves are written to a log channel.

## Commands

| Command | What it does | Who |
|---|---|---|
| `/play query` | Play a song, a link or a playlist | Anyone in voice |
| `/skip` · `/stop` | Skip the track, or stop and leave — straight away or by vote | Listeners |
| `/pause` · `/resume` | Pause and resume | Listeners |
| `/queue [page]` · `/nowplaying` | Show the queue, or the current track with its buttons | Anyone |
| `/volume level` · `/loop mode` · `/shuffle` | Volume 0–100, loop off / track / queue, shuffle | Listeners |
| `/remove position` · `/clear` | Remove one track, or empty the queue | Listeners |
| `/lyrics [song]` | Lyrics of the current track, or of any song | Anyone |
| `/setup` | Open the settings panel | Staff |
| `/captcha test` | Try the captcha without touching your roles, then see the expected squares | Staff |
| `/captcha reset <member>` | Clear a member's misses and timeout | Staff |
| `/captcha panel` | Post the Verify panel again | Staff |
| `/captcha reload` | Reload the photo pool | Staff |
| `/room name · limit · lock · unlock · invite · transfer` | Customise the room you own | Room owner |
| `/move to [member] [role] [from]` | Move one member, everyone in voice with a role, or a whole channel | Move Members |
| `/gather to` | Pull everyone in voice into one channel, with a button to send them back | Move Members |
| `/split teams [from]` | Shuffle a channel into 2–4 teams across empty rooms | Move Members |
| `/disconnect [member] [channel]` | Disconnect a member or a whole channel | Move Members |
| `/shake member [times] [to]` | Bounce a member through random channels, with a Stop button | Move Members |
| `/lock channel [duration]` | Lock a channel, optionally for a while (`30m`, `2h`, `1h30`) | Move Members |
| `/unlock channel` · `/locks` | Unlock, or list locks with an unlock menu | Move Members |

**Listeners** are the people in Ditto's voice channel. **Staff** means a staff
role picked in `/setup`, Administrator, or the server owner; staff can control
the music from anywhere and never need a vote. The owner — and the user in
`OWNER_ID` — pass every check. French Discord clients see French command
options (`/move vers:` instead of `to:`).

## Setting up a server

1. **Invite Ditto** — replace `YOUR_CLIENT_ID` with your application ID:

   ```text
   https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&scope=bot+applications.commands&permissions=1099800103952
   ```

   That grants View Channels, Send Messages, Embed Links, Attach Files, Read
   Message History, Manage Channels, Manage Roles, Connect, Speak, Move
   Members and Timeout Members.
2. In **Server Settings → Roles**, drag Ditto's role **above** every role it
   hands out.
3. Run **`/setup`**. Four pages, each made of menus:

   | Page | You pick |
   |---|---|
   | Verification | Member role, pending role, verification channel |
   | Quarantine | Quarantine role, and the bots whose arrivals go there |
   | Staff | Roles allowed to use every Ditto command |
   | Voice & logs | Rooms, log channel, voice log and auto-AFK, language |

   **Auto-detect** fills empty settings from common English and French names
   and never overwrites a choice you made.

To put the captcha in front of the whole server, take every permission away
from `@everyone`, give them to the member role, and let `@everyone` see only the
verification channel.

## Install

Needs [Node.js](https://nodejs.org/) 20+ and the **Server Members** intent
(Developer Portal → Bot → Privileged Gateway Intents).

```bash
git clone https://github.com/da0t-exe/Ditto.git
cd Ditto
npm install
cp .env.example .env
npm start
```

Slash commands are registered on every server each time the bot starts, so
they show up instantly — there is no deploy step. On the first start Ditto
fetches what it needs by itself: FFmpeg comes with `npm install`, yt-dlp is
downloaded into `data/bin` and updated daily, and the captcha photo pool (up
to 150 photos per category) builds itself in the background.

| Variable | |
|---|---|
| `BOT_TOKEN` | The bot's token — **required** |
| `OWNER_ID` | A user who passes every permission check |
| `GUILD_IDS` | Comma-separated servers to run on (empty = all) |
| `DATA_DIR` | Where state is kept (default `data/`) |
| `CAPTCHA_AUTOFETCH=0` | Do not build the photo pool on startup |

| Script | |
|---|---|
| `npm start` | Run the bot |
| `npm run dev` | Run and restart on file changes |
| `npm run typecheck` | Type-check without running |
| `npm run captcha:fetch` | Build or top up the photo pool by hand |

**Pterodactyl:** use a Node.js 20+ image (22 recommended) with `npm start` as
the startup command. To update, set it once to
`git fetch origin && git reset --hard origin/main && npm install --omit=dev && npm start`,
start, then set it back — `.env` and `data/` are never touched.

## Architecture

TypeScript on discord.js 14, run directly with `tsx` (no build step), state in
SQLite through `better-sqlite3`, images with `sharp`, audio through
`@discordjs/voice`, yt-dlp and FFmpeg.

```
apps/bot/
├── assets/fonts/       Roboto, used to draw the captcha instruction
└── src/
    ├── index.ts        Client, intents, per-server command registration
    ├── env.ts          .env loading
    ├── core/
    │   ├── config.ts   Per-server settings and auto-detection
    │   ├── db.ts       SQLite schema
    │   ├── dispatch.ts Routes commands and buttons to features
    │   ├── i18n.ts     English / French text and command localisations
    │   ├── perms.ts    Owner, staff and Move Members checks
    │   ├── logs.ts     Batched log-channel messages
    │   └── ui.ts       Embeds, colours, small helpers
    ├── features/
    │   ├── setup.ts    The /setup panel
    │   ├── captcha/    Photo pool builder, challenge renderer, verification flow
    │   ├── music/      Search and links, player, queue, now-playing buttons, lyrics
    │   └── voice/      Voice commands, locks, rooms, auto-AFK, voice log
    └── scripts/        captcha:fetch, selftest, music-check
```

- **Features** each export their slash commands, button and menu handlers,
  event listeners and a per-server start hook. Buttons carry ids like
  `captcha:ok` or `music:skip`, and the dispatcher routes them by prefix.
- **Captcha:** `build.ts` reads the Open Images annotations, crops each photo
  to a square around one category and keeps the box of every object in it.
  `grid.ts` picks the least-shown photo, applies a random zoom and mirror,
  works out which of the 16 squares hold the object, and draws the picture with
  `sharp`.
- **Music:** `search.ts` turns text or a link into tracks — YouTube Music's own
  search API for text, Spotify's embed pages, the iTunes and Deezer APIs, and
  yt-dlp for everything else. `player.ts` streams yt-dlp → FFmpeg → Discord,
  one player per server.
- **Storage** (`data/`, git-ignored): `ditto.db` holds settings, captcha
  attempts and history, locks and rooms; `captcha/` holds the photos and their
  manifest with each author and source; `bin/` holds yt-dlp.

## License

[MIT](LICENSE). The Ditto artwork is a fan drawing of a Pokémon © Nintendo /
Creatures / GAME FREAK and is not covered by this license. Captcha photos come
from [Open Images](https://storage.googleapis.com/openimages/web/index.html)
(CC BY 2.0), the Roboto font is under the SIL Open Font License 1.1, and
lyrics come from [LRCLIB](https://lrclib.net).
