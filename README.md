<div align="center">

<img src="./assets/ditto.png" width="112" alt="Ditto" />

# Ditto

Voice tools, a picture captcha and tiered roles for Discord.

<a href="https://github.com/da0t-exe/Ditto/releases"><img src="./assets/badges/version.svg" alt="version 0.2.0" /></a>
<img src="./assets/badges/node.svg" alt="node 20+" />
<img src="./assets/badges/discordjs.svg" alt="discord.js 14" />
<a href="LICENSE"><img src="./assets/badges/license.svg" alt="license MIT" /></a>

</div>

Ditto looks after the voice side of a server and the door in front of it: a
picture captcha for newcomers, roles that read cleanly on a profile, and voice
tools for moderators. It speaks **English and French**, and everything is set
up from Discord with `/setup`.

> Music is on the way. It will run on Lavalink and is not in this version yet.

## Features

### 🔐 Picture captcha

Newcomers only see a verification channel with a **Verify me** button. It
opens a private 3×3 grid of photos — *"select every image with traffic
lights"* — with nine buttons laid out like the grid.

- Photos come from [Open Images](https://storage.googleapis.com/openimages/web/index.html):
  traffic lights, bicycles, buses, cars, motorcycles, fire hydrants, stop
  signs, boats, palm trees, street lights and stairs. No drawings.
- A tile is a right answer only when the object fills enough of it, and a photo
  where it shows up small is never used as a wrong answer — no trick tiles.
- **No grid is served twice.** Every grid's fingerprint is stored, the least
  shown photos come first, and each tile is cropped, flipped and tinted at random.
- Three misses mean a 10-minute Discord **timeout**. Nobody is kicked.
- **Quarantine:** members brought in by a member-pushing bot are recognised
  from Discord's join source and get a quarantine role instead.

### 🎨 Roles

- After the captcha, members pick a **colour** and their **games**; `/roles`
  brings the menus back later.
- **Tier titles:** name a role like `━━ Games ━━` and it titles every role
  below it. Ditto shows the title only on members who hold a role of that tier,
  so profiles read as tidy floors with no empty headings.

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
| `/setup` | Open the settings panel | Staff |
| `/captcha test` | Try the captcha without touching your roles, then see the expected tiles | Staff |
| `/captcha reset <member>` | Clear a member's misses and timeout | Staff |
| `/captcha panel` | Post the Verify panel again | Staff |
| `/captcha reload` | Reload the photo pool | Staff |
| `/roles` | Pick your colour and games | Members |
| `/room name · limit · lock · unlock · invite · transfer` | Customise the room you own | Room owner |
| `/move to [member] [role] [from]` | Move one member, everyone in voice with a role, or a whole channel | Move Members |
| `/gather to` | Pull everyone in voice into one channel, with a button to send them back | Move Members |
| `/split teams [from]` | Shuffle a channel into 2–4 teams across empty rooms | Move Members |
| `/disconnect [member] [channel]` | Disconnect a member or a whole channel | Move Members |
| `/shake member [times] [to]` | Bounce a member through random channels, with a Stop button | Move Members |
| `/lock channel [duration]` | Lock a channel, optionally for a while (`30m`, `2h`, `1h30`) | Move Members |
| `/unlock channel` · `/locks` | Unlock, or list locks with an unlock menu | Move Members |

**Staff** means a staff role picked in `/setup`, Administrator, or the server
owner. The owner — and the user in `OWNER_ID` — pass every check. French
Discord clients see French command options (`/move vers:` instead of `to:`).

## Setting up a server

1. **Invite Ditto** — replace `YOUR_CLIENT_ID` with your application ID:

   ```text
   https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&scope=bot+applications.commands&permissions=1099798006800
   ```

   That grants View Channels, Send Messages, Embed Links, Attach Files, Read
   Message History, Manage Channels, Manage Roles, Connect, Move Members and
   Timeout Members.
2. In **Server Settings → Roles**, drag Ditto's role **above** every role it
   hands out.
3. Run **`/setup`**. Four pages, each made of menus:

   | Page | You pick |
   |---|---|
   | Verification | Member role, pending role, verification channel |
   | Quarantine | Quarantine role, and the bots whose arrivals go there |
   | Roles | Staff, colour and game roles |
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
they show up instantly — there is no deploy step. On the first start the
captcha photo pool (about 2,000 images, ~35 MB) builds itself in the background.

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

**Pterodactyl:** use a Node.js 20+ image with `npm start` as the startup
command. To update, set it once to
`git fetch origin && git reset --hard origin/main && npm install --omit=dev && npm start`,
start, then set it back — `.env` and `data/` are never touched.

## Architecture

TypeScript on discord.js 14, run directly with `tsx` (no build step), state in
SQLite through `better-sqlite3`, images with `sharp`.

```
apps/bot/src/
├── index.ts            Client, intents, per-server command registration
├── env.ts              .env loading
├── core/
│   ├── config.ts       Per-server settings and auto-detection
│   ├── db.ts           SQLite schema
│   ├── dispatch.ts     Routes commands and buttons to features
│   ├── i18n.ts         English / French text and command localisations
│   ├── perms.ts        Owner, staff and Move Members checks
│   ├── roleGroups.ts   Splits the role list into tiers
│   ├── logs.ts         Batched log-channel messages
│   └── ui.ts           Embeds, colours, small helpers
├── features/
│   ├── setup.ts        The /setup panel
│   ├── captcha/        Photo pool builder, grid renderer, verification flow
│   ├── roles/          Colour and game picker, tier titles
│   └── voice/          Voice commands, locks, rooms, auto-AFK, voice log
└── scripts/            captcha:fetch, selftest
```

- **Features** each export their slash commands, button and menu handlers,
  event listeners and a per-server start hook. Buttons carry ids like
  `captcha:ok` or `setup:page:roles`, and the dispatcher routes them by prefix.
- **Captcha pipeline:** `build.ts` reads the Open Images annotations, keeps
  photos where the object is large, crops each to a square around it and
  records which categories are clearly visible and which are only hinted at.
  `grid.ts` picks the least-shown photos, renders the grid with `sharp` and
  stores its fingerprint.
- **Storage** (`data/`, git-ignored): `ditto.db` holds settings, captcha
  attempts and grid history, locks and rooms; `captcha/` holds the photos and
  their manifest with each author and source.

## License

[MIT](LICENSE). The Ditto artwork is a fan drawing of a Pokémon © Nintendo /
Creatures / GAME FREAK and is not covered by this license. Captcha photos come
from [Open Images](https://storage.googleapis.com/openimages/web/index.html)
(CC BY 2.0).
