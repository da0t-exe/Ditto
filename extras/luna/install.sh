#!/usr/bin/env bash
#
# Ditto addon for the Luna Pterodactyl theme: a « Ditto » group in each server's
# sidebar (Overview, Captcha, Music, Voice, Settings, Logs), drawn in your Luna theme.
#
# Run it from the panel folder (usually /var/www/pterodactyl):
#   bash /path/to/Ditto/extras/luna/install.sh              install, or update
#   bash /path/to/Ditto/extras/luna/install.sh --eggs=5     show Ditto only on servers of egg 5
#   bash /path/to/Ditto/extras/luna/install.sh --remove     take it out
#
# Luna's own installer replaces the panel's sources on every Luna update:
# run this again afterwards to bring the pages back. Your sidebar settings stay.
set -Eeuo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PANEL="$(pwd)"
MODE=add
EGGS=""
for arg in "$@"; do
  case "$arg" in
    --remove) MODE=remove ;;
    --eggs=*) EGGS="${arg#--eggs=}" ;;
    *) printf 'Unknown option: %s\n' "$arg" >&2; exit 1 ;;
  esac
done

FILES=(
  app/Http/Controllers/Api/Client/Servers/DittoController.php
  resources/scripts/api/server/ditto.ts
  resources/scripts/components/server/ditto/DittoContainer.tsx
  resources/scripts/components/server/ditto/sections.tsx
  resources/scripts/components/server/ditto/store.ts
  resources/scripts/components/server/ditto/ui.tsx
)
# Left by older versions of this addon.
OLD_FILES=(resources/scripts/components/server/ditto/DittoTabs.tsx)

fail() {
  printf '\n%s\n' "$1" >&2
  exit 1
}

run() {
  printf '> %s\n' "$*"
  "$@"
}

[[ -f artisan ]] || fail "Run this from your Pterodactyl panel folder (usually /var/www/pterodactyl)."
[[ -f app/Models/ThemeSettings.php && -f resources/scripts/components/layout/Sidebar.tsx ]] ||
  fail "Luna is not installed on this panel. For a stock panel, see extras/pterodactyl in the Ditto repository."
command -v node >/dev/null 2>&1 || fail "Node.js is needed to rebuild the panel (Luna's installer sets it up)."
command -v yarn >/dev/null 2>&1 || fail "yarn is needed to rebuild the panel: npm install --global yarn"
[[ -z "$EGGS" || "$EGGS" =~ ^[0-9]+(,[0-9]+)*$ ]] || fail "--eggs takes egg numbers separated by commas, like --eggs=5,12"

# First install, in a terminal: ask which servers get the Ditto pages.
if [[ "$MODE" == add && -z "$EGGS" && -t 0 ]] && [[ "$(php "$HERE/navlink.php" "$PANEL" status 2>/dev/null)" != present ]]; then
  printf '\nWhich servers run Ditto? The Ditto pages are shown only on servers of these eggs.\n\n'
  php "$HERE/navlink.php" "$PANEL" eggs | while IFS=$'\t' read -r id name count; do
    printf '  %4s  %s (%s server%s)\n' "$id" "$name" "$count" "$([[ "$count" == 1 ]] || echo s)"
  done
  printf '\nEgg numbers, separated by commas (Enter: every server): '
  read -r EGGS
  EGGS="${EGGS// /}"
  [[ -z "$EGGS" || "$EGGS" =~ ^[0-9]+(,[0-9]+)*$ ]] || fail "Egg numbers only, like 5 or 5,12."
  printf '\n'
fi

# The panel shows its maintenance page while its front end is rebuilt, and always comes back.
run php artisan down || true
trap 'php artisan up >/dev/null 2>&1 || true' EXIT

rm -f "${OLD_FILES[@]}"
if [[ "$MODE" == add ]]; then
  for f in "${FILES[@]}"; do
    mkdir -p "$(dirname "$f")"
    cp "$HERE/files/$f" "$f"
    printf 'copied %s\n' "$f"
  done
  run node "$HERE/patch.cjs" "$PANEL" add
  if [[ -n "$EGGS" ]]; then
    run php "$HERE/navlink.php" "$PANEL" add "--eggs=$EGGS"
  else
    run php "$HERE/navlink.php" "$PANEL" add
  fi
else
  run node "$HERE/patch.cjs" "$PANEL" remove
  run php "$HERE/navlink.php" "$PANEL" remove
  for f in "${FILES[@]}"; do
    rm -f "$f"
  done
  rmdir resources/scripts/components/server/ditto 2>/dev/null || true
fi

run php artisan route:clear
run php artisan view:clear
[[ -d node_modules ]] || run yarn install
run env NODE_OPTIONS=--openssl-legacy-provider yarn build:production

# Give the files back to the panel's owner, as Luna's installer does.
OWNER="$(stat -c '%u:%g' "$PANEL" 2>/dev/null || true)"
if [[ -n "$OWNER" && "$(id -u)" == 0 ]]; then
  chown -R "$OWNER" public/assets routes resources/scripts app/Http/Controllers/Api/Client/Servers 2>/dev/null || true
fi

run php artisan up
trap - EXIT

if [[ "$MODE" == add ]]; then
  cat <<'EOF'

Ditto is in the panel. Open a server that runs Ditto: the « Ditto » group is in the
sidebar, under Overview. People with console access are logged in to Ditto by the
panel (Ditto 1.1 or later; older versions ask for the password from the console).

Rename, move, hide or limit the pages to some eggs in Admin → Theme editor →
Navigation. Run this script again after each Luna update.
EOF
else
  printf '\nDitto removed from the panel.\n'
fi
