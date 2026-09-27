# Ditto in the Pterodactyl panel

Ditto's dashboard is served by the bot itself, on the port Pterodactyl gives the
server (`SERVER_PORT`). There are three ways to reach it from the panel, from the
simplest to the most integrated.

## 1. Nothing to install

1. Start Ditto. The console prints the address and the admin password:

   ```text
   [dashboard] open http://203.0.113.10:25565
   [dashboard] admin password: 9Qe…   (set DASHBOARD_PASSWORD to choose your own)
   ```

2. Open that address in a browser — it is the server's main allocation, shown on
   the server's **Network** page.
3. Staff can instead type `/dashboard` in Discord for a one-time login link.

With **Luna**, you can also add this address as a custom link in the theme editor's
navigation, if your version offers custom links.

## 2. A « Ditto » tab — Luna or any panel built from source

Luna is a standalone theme (it replaces the panel's files instead of using
Blueprint) and ships its full source, so the tab is added like any other addon:
one file, one route, one rebuild. The same steps work on a stock Pterodactyl 1.11.

On the panel machine, as the user that owns the panel files:

```bash
cd /var/www/pterodactyl

# 1. The page
mkdir -p resources/scripts/components/server/ditto
cp /path/to/Ditto/extras/pterodactyl/blueprint/components/DittoPage.tsx \
   resources/scripts/components/server/ditto/DittoPage.tsx
```

2. Open `resources/scripts/routers/routes.ts` and add the import at the top:

   ```ts
   import DittoPage from '@/components/server/ditto/DittoPage';
   ```

   then this entry in the `server: [ … ]` list (after the `Files` entry, for example):

   ```ts
   {
       path: '/ditto',
       permission: null,
       name: 'Ditto',
       component: DittoPage,
   },
   ```

   In Luna, if the server routes are not in that file, search the source for
   `name: 'Files'` — the list you find is the one to add to.

3. Rebuild the panel's front end:

   ```bash
   yarn install --frozen-lockfile        # only the first time
   export NODE_OPTIONS=--openssl-legacy-provider   # only on Node 17 and later
   yarn build:production
   ```

Refresh the panel: every server has a **Ditto** tab. Updating Luna or the panel
overwrites `routes.ts`, so step 2 has to be done again after an update.

## 3. Blueprint (stock panel with Blueprint)

For a panel that uses [Blueprint](https://blueprint.zip) — not Luna — this folder
is a ready extension:

```bash
cd /path/to/Ditto/extras/pterodactyl/blueprint
zip -r ditto.blueprint .
mv ditto.blueprint /var/www/pterodactyl/
cd /var/www/pterodactyl && blueprint -install ditto
```

## HTTPS panels

Browsers refuse to show an `http://` page inside an `https://` panel. The tab then
shows an **Open in a new tab** button instead. To see the dashboard inside the
panel, put it behind HTTPS (a reverse proxy such as Caddy or Nginx, or a Cloudflare
Tunnel) and set in Ditto's `.env`:

```env
DASHBOARD_URL=https://ditto.example.com
DASHBOARD_FRAME_ANCESTORS=https://panel.example.com
```

then press **Change address** in the tab and save `https://ditto.example.com`.
