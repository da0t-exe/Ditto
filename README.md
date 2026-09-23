<div align="center">

<img src="./assets/Ditto.jpg" width="72" alt="" />

# Ditto

**A Discord bot for voice channels, member verification and roles.**

Node.js · TypeScript · discord.js 14 · SQLite · sharp

[![version](https://img.shields.io/badge/v0.1-000000?style=flat-square)](https://github.com/da0t-exe/Ditto/releases)
[![node](https://img.shields.io/badge/Node%2020%2B-000000?style=flat-square)](#install)
[![license](https://img.shields.io/badge/MIT-000000?style=flat-square)](LICENSE)

</div>

## What it is

Ditto runs the voice side of a server and the door in front of it: a picture
captcha for newcomers, roles that read cleanly on a profile, and a set of voice
tools for whoever holds **Move Members**.

Written in TypeScript. Commands register themselves on startup, state lives in
SQLite, and `npm start` is the only step.

> **Music is on the way.** It will run on Lavalink and is not in this version yet.

## Verification

New members see a single channel with a **Verify** button. It opens a private
3×3 grid of photos — *"select every image with traffic lights"* — and nine
buttons laid out like the grid.

- Photos come from [Open Images](https://storage.googleapis.com/openimages/web/index.html):
  traffic lights, bicycles, buses, cars, motorcycles, fire hydrants, stop
  signs, boats, palm trees, street lights and stairs. Drawings are excluded.
- An image only counts as a right answer when the object fills enough of the
  tile. An image where it appears only in a corner is never used as a wrong
  answer either, so no tile is a trick question.
- **No grid is served twice.** Every grid's fingerprint is stored, the least
  shown photos are picked first, and each tile is cropped, flipped and tinted
  at random, so the same photo never looks the same twice.
- Three wrong answers put the member in a Discord **timeout** (10 minutes by
  default). Nobody is kicked.
- Members brought in by a member-pushing bot (detected from Discord's join
  source) get the `nope` role instead, and never see the server.

The image pool (about 2,000 photos, ~35 MB) builds itself in the background on
the first start.

## Roles

- After the captcha, members pick a **colour** and their **games** from two
  menus. `/roles` brings the menus back later.
- **Tier titles.** A role named `━━━ 🎮 Jeux ━━━` is the title of every role
  below it, down to the next title. Ditto gives a member the title only while
  they hold a role in that tier, so profiles read as clean floors instead of
  empty headings.

## Voice

Requires **Move Members**.

| | |
|---|---|
| `/move` | Move one member, everyone with a role, or a whole channel |
| `/gather` | Pull everyone in voice into one channel — with a button to send them all back |
| `/split` | Shuffle a channel into 2–4 teams across empty rooms |
| `/disconnect` | Disconnect a member or a whole channel |
| `/shake` | Bounce a member through random channels, with a Stop button |
| `/lock` | Lock a channel, optionally for a while (`30m`, `2h`) — members who leave are pulled back |
| `/unlock` · `/locks` | Unlock, or list locks with an unlock menu |

Staff are never pulled back by a lock, and moving someone with a Ditto command
stops tracking them.

**Rooms.** The first person in an empty room owns it and can use `/room` to
rename it, cap it, lock it, invite someone or hand it over. When the last
person leaves, the room goes back to its original name, limit and permissions.

Members who stay deafened for 10 minutes are moved to the AFK channel, and
joins, leaves and moves are written to the log channel.

## Permissions

| Command | Needs |
|---|---|
| `/roles`, `/room` (in your own room) | anyone |
| Voice commands | Move Members |
| `/setup`, `/captcha` | Staff tier, Administrator, or server owner |

The server owner — or the user in `OWNER_ID` — passes every check.

## Install

Needs [Node.js](https://nodejs.org/) 20+ and a Discord application with the bot
already invited.

In the Developer Portal, enable the **Server Members** intent. In the server,
drag the bot's role **to the top** of the role list: it can only manage roles
below its own.

```bash
git clone https://github.com/da0t-exe/Ditto.git
cd Ditto
npm install
cp .env.example .env
```

```env
BOT_TOKEN=your_bot_token
```

That is the only required variable. Optional:

| | |
|---|---|
| `OWNER_ID` | A user who passes every permission check (the server owner already does) |
| `GUILD_IDS` | Comma-separated servers to run on; empty means all |
| `DATA_DIR` | Where state is stored (default `data/`) |
| `CAPTCHA_AUTOFETCH=0` | Do not build the image pool on startup |

On startup Ditto finds its roles and channels by name — `Membres`,
`🔐 Vérification`, `nope`, `✅vérification`, `📜logs`, `🧪test-captcha` and the
tier titles. Run `/setup` after renaming anything.

## Running

```bash
npm start
```

Slash commands are registered per server every time the bot starts, so they
appear instantly and there is no separate deploy step.

| | |
|---|---|
| `npm start` | Run the bot |
| `npm run dev` | Run and restart on file changes |
| `npm run typecheck` | Type-check without running |
| `npm run captcha:fetch` | Build or top up the captcha image pool by hand |

## Deploying on Pterodactyl

Use a **Node.js 20+** Docker image (22 recommended) and keep the startup command
as `npm start`.

To update, set the startup command to this once, start the server, then set it
back to `npm start`:

```text
git fetch origin && git reset --hard origin/main && npm install --omit=dev && npm start
```

`data/` and `.env` are git-ignored, so the reset never touches them.

## Project layout

```
apps/bot/src/
  index.ts              Client, startup, per-server command registration
  core/                 Config, SQLite, permissions, logging, shared UI
  features/captcha/     Image pool builder, grid generator, verification flow
  features/roles/       Colour and game picker, tier titles
  features/voice/       Voice commands, locks, rooms, auto-AFK, voice log
  features/setup.ts     Role and channel detection
```

State lives in the git-ignored `data/` directory, so `git reset --hard` never
wipes it:

| | |
|---|---|
| `data/ditto.db` | Settings, locks, rooms, captcha attempts and grid history |
| `data/captcha/` | Captcha photos and their manifest |

## Credits

Captcha photos come from Open Images and are licensed CC BY 2.0. Each photo's
author and source are listed in `data/captcha/manifest.json`.

## License

MIT — see [LICENSE](LICENSE).

<div align="center">
<sub>Built by <a href="https://github.com/da0t-exe">da0t-exe</a></sub>
</div>
