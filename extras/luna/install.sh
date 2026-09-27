#!/usr/bin/env bash
#
# Ditto addon for the Luna Pterodactyl theme: a « Ditto » tab in each server page,
# with the bot's dashboard drawn in your Luna theme.
#
# Run it from the panel folder (usually /var/www/pterodactyl):
#   bash /path/to/Ditto/extras/luna/install.sh            install, or update
#   bash /path/to/Ditto/extras/luna/install.sh --remove   take it out
#
# Luna's own installer replaces the panel's sources on every Luna update:
# run this again afterwards to bring the tab back.
set -Eeuo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PANEL="$(pwd)"
MODE=add
[[ "${1:-}" == "--remove" ]] && MODE=remove

FILES=(
  app/Http/Controllers/Api/Client/Servers/DittoController.php
  resources/scripts/api/server/ditto.ts
  resources/scripts/components/server/ditto/DittoContainer.tsx
  resources/scripts/components/server/ditto/DittoTabs.tsx
  resources/scripts/components/server/ditto/ui.tsx
)

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

# The panel shows its maintenance page while its front end is rebuilt, and always comes back.
run php artisan down || true
trap 'php artisan up >/dev/null 2>&1 || true' EXIT

if [[ "$MODE" == add ]]; then
  for f in "${FILES[@]}"; do
    mkdir -p "$(dirname "$f")"
    cp "$HERE/files/$f" "$f"
    printf 'copied %s\n' "$f"
  done
  run node "$HERE/patch.cjs" "$PANEL" add
  run php "$HERE/navlink.php" "$PANEL" add
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

Ditto tab installed. Open a server that runs Ditto: « Ditto » is in the sidebar,
under Overview (move it, rename it or show it only for some eggs in
Admin → Theme editor → Navigation).
Log in with the admin password Ditto prints in that server's console.
Run this script again after each Luna update.
EOF
else
  printf '\nDitto tab removed.\n'
fi
