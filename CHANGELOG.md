# Changelog

Each section is also published as a [GitHub release](https://github.com/da0t-exe/Ditto/releases).
Versions up to 0.5.2 are described on the releases page only.

## 0.6.0 — 2026-09-27

The biggest release so far: a captcha that looks exactly like reCAPTCHA, faster
music with a new player, a web dashboard, and Ditto's own pages inside the
Pterodactyl panel. Ditto now speaks English only.

### Captcha

- **Drawn exactly like a reCAPTCHA 4×4 image challenge**: header, grid and footer
  measured pixel for pixel, with sixteen buttons laid out like the squares and
  **Skip** turning into **Verify** once a square is ticked.
- **A photo database ships with Ditto**: 111 hand-picked Open Images street photos
  (traffic lights, bicycles, buses, cars, motorcycles, fire hydrants and more)
  with the position of every object. Nothing is downloaded or built on first start anymore;
  `captcha:fetch` only adds extra photos. The photo folder of older versions is
  removed on start.
- **Instant**: a stock of challenges is drawn in advance, so the picture shows the
  moment **Verify me** is pressed and a miss swaps it at once. No challenge is
  served twice.
- Some challenges have nothing to tick: the answer is **Skip**.
- The number of attempts and the pause after the last miss are settings, and the
  member role is optional: the pending role alone can gate the server.

### Music

- **No suggestion list**: `/play` takes a song name or a link and keeps the best
  match, leaving out remixes, live and sped-up versions nobody asked for.
- **Faster**: Ditto joins the voice channel while it searches, looks up the next
  two tracks ahead of time and remembers stream addresses.
- **No freezes**: nothing Ditto runs in the background (Java checks, archives,
  yt-dlp) blocks the bot anymore.
- **Smoother**: Lavalink runs with a larger audio buffer and a low-pause garbage
  collector, and backs off if it keeps crashing.
- **A new live player**: cover, a progress bar that moves on its own, up next,
  previous, pause, skip, stop, loop, volume, shuffle, queue, lyrics, and a filter
  menu that applies live. New: `/previous` and `/play … next`.
- Links to the host or its local network are refused before anything fetches them.

### Setup

- `/setup` opens on an overview with a **⚡ Quick setup** button: it creates an
  *Unverified* role, `#verify` and `#ditto-logs`, hides the other channels from
  *Unverified* and posts the Verify panel. Deleting the role undoes it.
- `/help` lists what Ditto can do.

### Web dashboard

- Served by Ditto itself, on the server's own port on Pterodactyl
  (`SERVER_PORT`), else `DASHBOARD_PORT` or 3000.
- Every `/setup` setting, Quick setup and Auto-detect; captcha statistics over
  14 days; the music player and its queue; locked channels; the live activity log.
- Log in with the admin password printed in the console (or `DASHBOARD_PASSWORD`),
  or with a one-time link from `/dashboard`, which opens only that Discord server
  for its staff.

### Pterodactyl and Luna

- **Luna theme**: `extras/luna/install.sh` adds a **Ditto** group to each server's
  sidebar, under Overview: **Overview, Captcha, Music, Voice, Bot settings, Logs**.
  The pages are built from Luna's own cards, stat blocks, switches and dialogs,
  in your theme's colours, and work on HTTPS panels.
- **No password in the panel**: anyone with console access is logged in to Ditto
  by the panel, through a one-time code sent to the server's console. Ditto only
  accepts a code from its own console, once, within a minute, and keeps it out of
  the console output. `DASHBOARD_CONSOLE_LOGIN=0` turns this off.
- The installer asks once which eggs run Ditto, keeps what you change in the
  theme editor, and must be run again after each Luna update. `--remove` restores
  the panel's files exactly.
- Stock panels and Blueprint: see `extras/pterodactyl`.

### Also

- **English only**: the French translations and the language setting are gone.
- **npm 12**: the install scripts Ditto needs (better-sqlite3, ffmpeg-static,
  esbuild) are listed in `allowScripts`, so a fresh install with npm 12, which
  blocks unlisted ones, still works, and npm 11 stops warning.
- The dashboard returns an invite link, shown when the bot is in no server yet.

### Upgrading

```text
git fetch origin && git reset --hard origin/main && npm install --omit=dev && npm start
```

`.env` and `data/` are kept. The captcha photos built by older versions are
removed on the first start (they now ship with Ditto). For the Luna pages, run on
the panel machine:

```bash
cd /var/www/pterodactyl && bash /path/to/Ditto/extras/luna/install.sh
```

### Tested

Type-checked, and `npm run selftest` passes: 60 unique captcha challenges, every
message layout within Discord's limits, the search ranking and the private-link
guard. The bot started on Pterodactyl (Node 22) on four servers: 111 captcha
photos ready, yt-dlp ready, Lavalink 4.2.2 with its YouTube plugin connected.
The Luna pages were built into Luna and used through its sidebar against a
simulated panel, including the automatic login and the password fallback; the
installer was run end to end on a mock panel. They have not yet run on a real
panel.
