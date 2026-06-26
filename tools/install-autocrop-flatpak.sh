#!/usr/bin/env bash
set -euo pipefail

app_id="${APP_ID:-com.stremio.Stremio}"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
install_dir="${XDG_DATA_HOME:-$HOME/.local/share}/stremio-autocrop"
state_dir="${XDG_STATE_HOME:-$HOME/.local/state}/stremio-autocrop"
event_log="$state_dir/events.log"

mkdir -p "$install_dir"
mkdir -p "$state_dir"
install -m 0644 "$script_dir/stremio-server-autocrop-wrapper.js" "$install_dir/stremio-server-autocrop-wrapper.js"

flatpak override --user \
  --filesystem="$install_dir:ro" \
  --filesystem="$state_dir:create" \
  --unset-env="STREMIO_AUTOCROP_LUA_SOURCE" \
  --unset-env="STREMIO_AUTOCROP_LUA_PATH" \
  --env="SERVER_PATH=$install_dir/stremio-server-autocrop-wrapper.js" \
  --env="STREMIO_ORIGINAL_SERVER_PATH=/app/libexec/stremio/server.js" \
  --env="STREMIO_AUTOCROP_LOG=$event_log" \
  "$app_id"

flatpak kill "$app_id" >/dev/null 2>&1 || true

# NixOS font symlinks can change underneath Flatpak's per-app fontconfig cache.
flatpak run --command=fc-cache "$app_id" -f >/dev/null 2>&1 || true

flatpak_home="$HOME/.var/app/$app_id"
rm -rf \
  "$flatpak_home/cache/stremio/WebKitCache" \
  "$flatpak_home/cache/stremio/CacheStorage" \
  "$flatpak_home/cache/webkitgtk-6.0/WebKitCache" \
  "$flatpak_home/cache/webkitgtk-6.0/CacheStorage"

printf 'Installed Stremio autocrop override for %s\n' "$app_id"
printf 'Restart Stremio and click the Crop toolbar button while video is playing.\n'
printf 'Autocrop event log: %s\n' "$event_log"
