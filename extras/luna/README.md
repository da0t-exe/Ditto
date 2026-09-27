# Ditto tab for the Luna theme

A **Ditto** page inside every server of a Pterodactyl panel that runs the
Luna theme. It is drawn by the panel itself, in your Luna
colours, light or dark: no frame, no second address to open.

- **Overview**: members, captcha results, the setup checklist, Quick setup,
  Auto-detect, Post the panel, the latest activity.
- **Captcha**: the last 14 days, the latest events and every captcha setting.
- **Music**: the player (seek, pause, skip, loop, filters, volume), add a song
  (Ditto picks the best match), and the queue.
- **Voice**: locked channels (unlock them), rooms, the voice log and AFK.
- **Settings** and **Logs**.

It works on HTTPS panels too: the browser only talks to the panel, and the panel
talks to Ditto on the server's own port.

## Install

On the panel machine, as root (or the user that owns the panel files):

```bash
cd /var/www/pterodactyl
bash /path/to/Ditto/extras/luna/install.sh
```

The script:

1. puts the panel in maintenance mode;
2. copies five files (the page, its API client and a small PHP controller);
3. adds the page's route and the API route, between `ditto-addon` markers;
4. adds **Ditto** to the server sidebar, under Overview;
5. rebuilds the front end (`yarn build:production`, about a minute) and brings the
   panel back.

Nothing of Luna is changed beyond those two marked blocks and the sidebar entry.

**Run it again after every Luna update.** Luna's installer replaces the panel's
sources, which removes the tab. Running the script twice never adds anything twice.

## Use

1. Start Ditto in a server of this panel. The dashboard listens on the server's
   **primary allocation** (`SERVER_PORT`), which is what the tab connects to. Do not
   set `DASHBOARD=0` or a different `DASHBOARD_PORT`.
2. Open the server, then **Ditto** in the sidebar.
3. Log in with the admin password printed in the server's console (or your
   `DASHBOARD_PASSWORD`), or with a code from `/dashboard` in Discord.

The page is shown to anyone with **console access** to the server (owner, admins,
and subusers with the Console permission), and they still need Ditto's password.
The browser keeps the login until you press the log-out button.

In a server that does not run Ditto, the page says so. To show the link only for
Ditto's egg, or to move or rename it: **Admin → Theme editor → Navigation**, entry
**Ditto** (egg filter, order, label, icon).

## Remove

```bash
cd /var/www/pterodactyl
bash /path/to/Ditto/extras/luna/install.sh --remove
```

This takes out the files, the two marked blocks and the sidebar entry, then
rebuilds the panel.

## How it works

| Part | File in the panel |
|---|---|
| The page, its tabs and controls | `resources/scripts/components/server/ditto/` |
| The API client | `resources/scripts/api/server/ditto.ts` |
| The panel route `/server/{id}/ditto` | `resources/scripts/routers/routes.ts` (marked block) |
| The API route `/api/client/servers/{id}/ditto/…` | `routes/api-client.php` (marked block) |
| The relay to Ditto | `app/Http/Controllers/Api/Client/Servers/DittoController.php` |

`DittoController` sits behind the panel's usual server checks (logged in, server
access, console permission). It relays the request to
`http://<primary allocation>:<port>/api/…` (the node's address when the allocation
is `0.0.0.0`), only for Ditto's own API paths, and returns JSON only, so nothing
from the game server can run in the panel. The Ditto login travels in an
`X-Ditto-Token` header and is never stored by the panel.

The panel machine must be able to reach the node on the server's port; it can when
the port is open to players.

## Troubleshooting

| Message in the tab | Cause |
|---|---|
| « Ditto does not answer on … » | Ditto is not running, or not on the primary allocation, or the panel cannot reach that port. |
| « This server does not answer like Ditto » | Something else listens on that port. |
| The **Ditto** link is missing | Run the script again (after a Luna update), or check it is enabled in the theme editor. |
| A blank page after an update | The front end was rebuilt by Luna without the addon: run the script again. |

Without Luna (stock panel or Blueprint), see [extras/pterodactyl](../pterodactyl/README.md).
