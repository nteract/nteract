#!/usr/bin/env bash
set -euo pipefail

# Tauri CLI 2.11.0 downloads a 2024 linuxdeploy build that predates
# LINUXDEPLOY_EXCLUDED_LIBRARIES. Seed its tools cache with a pinned build
# that honors exclusions, including in the GTK plugin's recursive calls.
if [[ $(uname -s) != Linux || $(uname -m) != x86_64 ]]; then
  echo "This AppImage packaging tool is for Linux x86_64" >&2
  exit 1
fi

tools_dir="${XDG_CACHE_HOME:-$HOME/.cache}/tauri"
workdir=$(mktemp -d)
trap 'rm -rf "$workdir"' EXIT
version=1-alpha-20251107-1
sha256=c20cd71e3a4e3b80c3483cef793cda3f4e990aca14014d23c544ca3ce1270b4d
curl --fail --location --retry 3 \
  "https://github.com/linuxdeploy/linuxdeploy/releases/download/$version/linuxdeploy-x86_64.AppImage" \
  --output "$workdir/linuxdeploy.AppImage"
printf '%s  %s\n' "$sha256" "$workdir/linuxdeploy.AppImage" | sha256sum --check
mkdir -p "$tools_dir"
install -m 755 "$workdir/linuxdeploy.AppImage" "$tools_dir/linuxdeploy-x86_64.AppImage"
