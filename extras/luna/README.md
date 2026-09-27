# Ditto in the Luna theme

Ditto's own pages inside every server of a Pterodactyl panel that runs the Luna
theme. They sit in a **Ditto** group of the server sidebar, just under Overview,
and are drawn with Luna's own cards, stat blocks, switches and dialogs, in your
theme's colours, dark or light.

| Page | What you do there |
|---|---|
| **Overview** | Members, captcha results and music at a glance, the setup checklist, Quick setup, recent activity |
| **Captcha** | The last 14 days, the latest newcomers, and the captcha settings |
| **Music** | The player (pause, skip, seek, loop, filters, volume), add a song (Ditto picks the best match), the queue |
| **Voice** | Locked channels (unlock them), rooms, voice log, auto-AFK |
| **Bot settings** | Roles, channels, staff, quarantine and the setup tools |
| **Logs** | Everything Ditto did, live, with a filter |

**No password to type.** Anyone who can use the server's console is logged in to
Ditto by the panel. The panel types a one-time code in the console, Ditto trades it
for a session, and the panel keeps that session to itself. It needs Ditto 0.6 or
later; with an older Ditto, the pages ask for the admin password from the console.

It works on HTTPS panels too: the browser only talks to the panel, and the panel
talks to Ditto on the server's own port.

## Install

On the panel machine, as root (or the user that owns the panel files):

```bash
cd /var/www/pterodactyl
bash /path/to/Ditto/extras/luna/install.sh
```

The first time, the script lists your eggs and asks which ones run Ditto: the
Ditto group then only shows on those servers. Press Enter to show it everywhere.
You can also pass them directly: `install.sh --eggs=5` (or `--eggs=5,12`).

The script then:

1. puts the panel in maintenance mode;
2. copies six files (the pages, their API client and a small PHP controller);
3. adds the pages' routes and the API route, between `ditto-addon` markers;
4. adds the **Ditto** group to the server sidebar;
5. rebuilds the front end (`yarn build:production`, about a minute) and brings the
   panel back.

Nothing else of Luna is changed.

**Run it again after every Luna update.** Luna's installer replaces the panel's
sources, which takes the pages out. Your sidebar settings are kept, and running the
script twice never adds anything twice.

## Use

1. Start Ditto (0.6 or later) in a server of this panel. Its dashboard listens on
   the server's **primary allocation** (`SERVER_PORT`), which is where the panel
   looks for it: do not set `DASHBOARD=0` or a different `DASHBOARD_PORT`.
2. Open the server: the **Ditto** group is in the sidebar.

The pages are for people with **console access** to the server (owner, admins, and
subusers with the Console permission), since they could already type in Ditto's
console. To turn the automatic login off, set `DASHBOARD_CONSOLE_LOGIN=0` for Ditto:
the pages then ask for the admin password.

To rename, move or hide a page, or change the eggs: **Admin → Theme editor →
Navigation**, group **Ditto**. Switch a page off rather than deleting it: the
install script puts deleted pages back.

## Remove

```bash
cd /var/www/pterodactyl
bash /path/to/Ditto/extras/luna/install.sh --remove
```

This takes out the files, the marked blocks and the Ditto group, then rebuilds the
panel.

## How it works

| Part | File in the panel |
|---|---|
| The pages | `resources/scripts/components/server/ditto/` |
| The API client | `resources/scripts/api/server/ditto.ts` |
| The routes `/server/{id}/ditto/…` | `resources/scripts/routers/routes.ts` (marked block) |
| The API route `/api/client/servers/{id}/ditto/…` | `routes/api-client.php` (marked block) |
| The relay to Ditto | `app/Http/Controllers/Api/Client/Servers/DittoController.php` |
| The sidebar group | Luna's theme settings (`layout.nav_links`) |

`DittoController` sits behind the panel's usual server checks (logged in, server
access, console permission). It relays requests to
`http://<primary allocation>:<port>/api/…` (the node's address when the allocation
is `0.0.0.0`), only for Ditto's own API paths, and returns JSON only, so nothing
from the game server can run in the panel.

To log someone in, it sends `ditto-panel-login <code>` to the server's console
through Wings, then posts the code to Ditto's `/api/login/console`. Ditto accepts a
code only if it arrived through its console, only once, and only within a minute;
and keeps it out of the console output. The session is stored encrypted in the panel's
cache for 12 hours, one per panel user and server, and never reaches the browser.

The panel machine must be able to reach the node on the server's port; it can when
the port is open to players.

## Troubleshooting

| What you see | Cause |
|---|---|
| « Ditto is not answering » | Ditto is not running, or not on the primary allocation, or the panel cannot reach that port. The page tries again every 10 seconds. |
| « This server does not answer like Ditto » | Something else listens on that port. |
| The pages ask for a password | Ditto is older than 0.6, `DASHBOARD_CONSOLE_LOGIN=0` is set, or the server's console did not take the code (the server must be running). |
| No **Ditto** group in the sidebar | Wrong egg (see the theme editor), or a Luna update: run the script again. |
| A blank page after an update | Luna rebuilt the front end without the addon: run the script again. |

Without Luna (stock panel or Blueprint), see [extras/pterodactyl](../pterodactyl/README.md).
