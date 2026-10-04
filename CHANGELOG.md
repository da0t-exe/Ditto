# Changelog

Each section is also published as a [GitHub release](https://github.com/da0t-exe/Ditto/releases).
Versions up to 0.5.2 are described on the releases page only.

## Unreleased

Fixes from reading the whole code again and running it without Discord.

### Security

- **Private links**: an address of the host or its network written as IPv6
  (`http://[::ffff:127.0.0.1]:2333/…`) got past the check and reached yt-dlp and
  Lavalink. Link-local, multicast and benchmark ranges are refused too, as is a
  private address reached through NAT64, and the address a share link leads to is
  checked like any other.
- `undici` updated for three advisories (it comes with discord.js).

### `/play`

- **Suggestions are back.** As a name is typed, `/play` suggests songs from YouTube
  Music, the closest match first, as it did before 0.6. Picking one plays exactly
  that song; sending the words without picking still plays the best match. The
  first suggestion is got ready while the list is on screen, so it starts within a
  second when it is the one picked.
- **"That link could not be played" on links that should play.** A link copied from
  a YouTube mix or radio (`&list=RD…`, which nearly every link shared from YouTube
  Music carries) made Ditto list the whole mix: hundreds of tracks, 20 to 30
  seconds, cut off at 25. Such a link now plays the song it names. A playlist
  opened on one of its videos starts with that video, and a video whose playlist
  cannot be read still plays.
- A YouTube link is read and made ready to play in one lookup instead of two.
- yt-dlp is no longer alone in reading links. Lavalink reads SoundCloud, Bandcamp,
  Twitch and plain audio files itself, in a fraction of a second where yt-dlp took
  three; each takes over when the other fails, for YouTube too.
- Vimeo is no longer listed among the sites that play: yt-dlp now wants an account
  for it, and Lavalink reads its videos but cannot play them.
- Links are found inside `< >` or next to a few words, and Spotify and Deezer share
  links (`spotify.link`, `link.deezer.com`) are followed.
- When a link cannot be played, Ditto says why — gone, private or age-restricted,
  channel not live, nothing to play there, address not found — and the console
  shows what yt-dlp answered.
- YouTube now and then refuses a stream address it has just given out. Ditto asks
  for a fresh one before falling back on slower ways, and a track cut in the middle
  carries on from where it stopped instead of starting again.

### Music

- **The queue did not move on.** When a track ended or was skipped, the next one
  never started. Two things stood in the way: the end of a track reaches Ditto
  under another name than the one it listened for (it keeps its own queue rather
  than the Lavalink client's), and it recognised its track by comparing what
  Lavalink sends back with what it had sent, which differs as soon as some of the
  track has played. Each play now carries a number. Skip, loop, "Queue finished"
  and leaving after the last track all hung on it.
- Skipping a clip (TikTok, X, Instagram) while it was still downloading could take
  the track that replaced it off the air, with a "could not play" message for the
  skipped one.
- `/stop` followed at once by `/play` made Ditto leave again: the new player was
  closed along with the old one, or by Discord's late confirmation that Ditto had
  left the channel.
- Started from the dashboard in an empty channel, Ditto leaves after a minute, as
  it does when everyone leaves.
- On Windows, the Java runtime could not be unpacked when another `tar` (Git's)
  came first on the PATH.
- Lavalink is started again when Java could not be launched at all, and an update
  waits for the old process to be gone before starting the new one.

### Captcha

- With a quarantine set up, newcomers kept full access to the server for 4 to 12
  seconds, the time it takes to learn where they came from. The pending role is
  now given first.
- A challenge drawn on the spot, when a wave of arrivals has emptied the stock, no
  longer runs past the three seconds Discord waits for an answer.

### Dashboard and settings

- A numeric setting sent without a value was saved as "not a number": captcha
  attempts without end, or members sent to AFK the moment they deafened. Values are
  now checked against their choices in one place, and settings damaged that way are
  read back as the defaults.
- A volume that is not a number, sent to the API, no longer breaks the volume.
- Auto-detect on the dashboard did not record the rooms it found or refresh the
  Verify panel, unlike in `/setup`.
- The song being typed and the channel picked were wiped each time the page
  refreshed; the logs stopped updating once they held 100 lines; ping, uptime and
  "Music starting" never changed after the page was opened.
- Stage channels are no longer offered as rooms (picking one was refused).
- The voice channel list says how many people are in each one, so music can be
  started where they are.
- The invite link is shown when the bot is in no server yet.

### Voice

- `/room` answers within Discord's delay however long the change takes, and says
  which permission is missing instead of "Something went wrong".
- `/lock` refuses a duration of zero (it locked with no limit) or of more than a
  year, and a lock on a deleted channel is removed.

### Also

- With `GUILD_IDS` set, Ditto now leaves the other servers alone: it still moved
  their deafened members to AFK, and the dashboard listed them.
- A bot that cannot log in (wrong token, Server Members intent off) stops with the
  reason instead of idling.
- A server whose member list cannot be loaded is still set up.
- `npm run selftest` also checks the settings, the music queue, what `/play` makes
  of what it is given, and the dashboard's API on a local port with a stand-in for
  Discord.
- `play-lab` runs the real `/play`, its suggestions and the queue commands against
  YouTube Music, yt-dlp and Lavalink with a stand-in for Discord, and times how
  long a track takes to start; `music-lab` plays the shapes links really come in.

### Tested

Type-checked; `npm run selftest` passes. Without Discord: Lavalink 4.2.2 started on
Windows and loaded YouTube, YouTube Music, SoundCloud, a direct stream address and
a downloaded file; 12 of 13 kinds of link really played (the sample X link no
longer holds a video); the dashboard was driven in a browser against a stand-in
server. With Discord, from the dashboard, in an empty voice channel: play,
progress, pause, seek, the next track starting by itself at the end of one, skip,
previous, loop, stop then play at once, and leaving the empty channel after a
minute. Slash commands and the captcha's buttons were not clicked in Discord.

The new `/play` was then tested without Discord. `play-lab` passes: suggestions,
every kind of input and its answer, the queue commands, and the time to the first
sound (0.3 s for a suggestion got ready ahead, about 3 s for one picked at once,
about 5 s for a YouTube link, under a second for SoundCloud and audio files).
`music-lab` played 18 of 20 kinds of link: the sample X link holds no video, and
Vimeo no longer plays. Links were also read with yt-dlp made to fail, to see
Lavalink and YouTube's embed service take over. The suggestions have not been typed
in Discord, nor the new `/play` heard in a voice channel.

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
