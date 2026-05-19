#!/usr/bin/env bash
set -euo pipefail

version="${TAURI_CLI_VERSION:-2.11.0}"
cargo_home="${CARGO_HOME:-$HOME/.cargo}"
cargo_bin="$cargo_home/bin"
mkdir -p "$cargo_bin"

if [[ -n "${GITHUB_PATH:-}" ]]; then
  echo "$cargo_bin" >>"$GITHUB_PATH"
fi
export PATH="$cargo_bin:$PATH"

target=""
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64 | Darwin-aarch64)
    target="aarch64-apple-darwin"
    ;;
  Darwin-x86_64)
    target="x86_64-apple-darwin"
    ;;
  Linux-x86_64)
    target="x86_64-unknown-linux-gnu"
    ;;
esac

install_from_release() {
  if [[ -z "$target" ]]; then
    echo "No prebuilt Tauri CLI asset mapping for $(uname -s)-$(uname -m)"
    return 1
  fi

  local archive_ext="zip"
  if [[ "$target" == *linux* ]]; then
    archive_ext="tgz"
  fi

  local asset="cargo-tauri-$target.$archive_ext"
  local url="https://github.com/tauri-apps/tauri/releases/download/tauri-cli-v$version/$asset"
  local tmp
  tmp="$(mktemp -d)"

  echo "Installing Tauri CLI v$version for $target from $url"
  if ! curl --retry 5 --retry-all-errors --connect-timeout 15 -fsSL "$url" -o "$tmp/$asset"; then
    rm -rf "$tmp"
    return 1
  fi

  case "$archive_ext" in
    zip)
      unzip -q -o "$tmp/$asset" -d "$tmp"
      ;;
    tgz)
      tar -xzf "$tmp/$asset" -C "$tmp"
      ;;
  esac

  local cargo_tauri
  cargo_tauri="$(find "$tmp" -type f -name cargo-tauri -print -quit)"
  if [[ -z "$cargo_tauri" ]]; then
    echo "Downloaded archive did not contain cargo-tauri"
    rm -rf "$tmp"
    return 1
  fi

  cp "$cargo_tauri" "$cargo_bin/cargo-tauri"
  chmod +x "$cargo_bin/cargo-tauri"
  rm -rf "$tmp"
}

if ! install_from_release; then
  echo "::warning::Direct Tauri CLI download failed; falling back to cargo install tauri-cli --version $version"
  cargo install tauri-cli --version "$version" --locked --force
fi

cargo tauri --version
