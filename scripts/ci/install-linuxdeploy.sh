#!/usr/bin/env bash
set -euo pipefail

# Tauri CLI 2.11.0 downloads a 2024 linuxdeploy build that predates
# LINUXDEPLOY_EXCLUDED_LIBRARIES. Seed its tools cache with a pinned build
# that honors exclusions, including in the GTK plugin's recursive calls.
# The bundler looks for linuxdeploy-<arch>.AppImage, where <arch> is the first
# component of the Rust target triple.
version=1-alpha-20251107-1
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)
    arch=x86_64
    sha256=c20cd71e3a4e3b80c3483cef793cda3f4e990aca14014d23c544ca3ce1270b4d
    ;;
  Linux-aarch64)
    arch=aarch64
    sha256=620095110d693282b8ebeb244a95b5e911cf8f65f76c88b4b47d16ae6346fcff
    ;;
  *)
    echo "This AppImage packaging tool is for Linux x86_64 or aarch64, not $(uname -s) $(uname -m)" >&2
    exit 1
    ;;
esac

tools_dir="${XDG_CACHE_HOME:-$HOME/.cache}/tauri"
workdir=$(mktemp -d)
trap 'rm -rf "$workdir"' EXIT
curl --fail --location --retry 3 \
  "https://github.com/linuxdeploy/linuxdeploy/releases/download/$version/linuxdeploy-$arch.AppImage" \
  --output "$workdir/linuxdeploy.AppImage"
printf '%s  %s\n' "$sha256" "$workdir/linuxdeploy.AppImage" | sha256sum --check
mkdir -p "$tools_dir"
install -m 755 "$workdir/linuxdeploy.AppImage" "$tools_dir/linuxdeploy-$arch.AppImage"
