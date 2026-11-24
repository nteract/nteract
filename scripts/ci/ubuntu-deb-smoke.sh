#!/usr/bin/env bash
set -euo pipefail

# Disabled from release gates while Linux desktop releases are AppImage-only.
# See docs/linux.md and contributing/releasing.md before re-enabling DEB
# package smokes.

usage() {
  echo "usage: ubuntu-deb-smoke.sh local <path-to-deb> <stable|nightly> [expected-version]" >&2
}

MODE=${1:-}
if [[ -z "$MODE" ]]; then
  usage
  exit 2
fi
shift

case "$MODE" in
  local)
    DEB_PATH=${1:?missing path-to-deb}
    CHANNEL=${2:?missing channel}
    EXPECTED_VERSION=${3:-}
    ;;
  *)
    usage
    exit 2
    ;;
esac

case "$CHANNEL" in
  stable)
    PACKAGE_NAME="nteract"
    CLI_NAME="runt"
    DAEMON_NAME="runtimed"
    MCP_NAME="nteract-mcp"
    APP_NAME="nteract"
    ;;
  nightly)
    PACKAGE_NAME="nteract-nightly"
    CLI_NAME="runt-nightly"
    DAEMON_NAME="runtimed-nightly"
    MCP_NAME="nteract-mcp-nightly"
    APP_NAME="nteract-nightly"
    ;;
  *)
    echo "Unsupported channel: $CHANNEL" >&2
    exit 2
    ;;
esac

export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y --no-install-recommends ca-certificates curl file systemd

if [[ ! -f "$DEB_PATH" ]]; then
  echo "Debian package not found: $DEB_PATH" >&2
  exit 1
fi

echo "=== Debian package metadata ==="
dpkg-deb --info "$DEB_PATH"
dpkg-deb --field "$DEB_PATH" Package Version Architecture

ACTUAL_PACKAGE=$(dpkg-deb --field "$DEB_PATH" Package)
if [[ "$ACTUAL_PACKAGE" != "$PACKAGE_NAME" ]]; then
  echo "Expected package $PACKAGE_NAME, got $ACTUAL_PACKAGE" >&2
  exit 1
fi

apt-get install -y --no-install-recommends "$DEB_PATH"

INSTALLED_VERSION=$(dpkg-query -W -f='${Version}' "$PACKAGE_NAME")
echo "Installed $PACKAGE_NAME version: $INSTALLED_VERSION"
if [[ -n "$EXPECTED_VERSION" && "$INSTALLED_VERSION" != "$EXPECTED_VERSION" ]]; then
  echo "Expected version $EXPECTED_VERSION, got $INSTALLED_VERSION" >&2
  exit 1
fi

echo "=== Installed package files ==="
dpkg -L "$PACKAGE_NAME" | sort

for command_name in "$CLI_NAME" "$DAEMON_NAME" "$MCP_NAME"; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Expected command missing from PATH: $command_name" >&2
    exit 1
  fi
  "$command_name" --version
done

for binary_name in "$CLI_NAME" "$DAEMON_NAME" "$MCP_NAME"; do
  if ! dpkg -L "$PACKAGE_NAME" | grep -E "/${binary_name}$" >/dev/null; then
    echo "Expected packaged binary missing: $binary_name" >&2
    exit 1
  fi
done

if ! dpkg -L "$PACKAGE_NAME" | grep -E "/${APP_NAME}\.desktop$" >/dev/null; then
  echo "Expected desktop file missing for $APP_NAME" >&2
  exit 1
fi

WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT

export HOME="$WORKDIR/home"
export XDG_CONFIG_HOME="$HOME/.config"
export XDG_DATA_HOME="$HOME/.local/share"
export XDG_CACHE_HOME="$HOME/.cache"
mkdir -p "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME"

set +e
"$CLI_NAME" daemon doctor --fix --no-start --json > "$WORKDIR/doctor.json" 2> "$WORKDIR/doctor.stderr"
doctor_status=$?
set -e

echo "=== daemon doctor stdout ==="
cat "$WORKDIR/doctor.json"
echo
echo "=== daemon doctor stderr ==="
cat "$WORKDIR/doctor.stderr"
echo

if [[ "$doctor_status" -ne 0 ]]; then
  echo "daemon doctor failed with status $doctor_status" >&2
  exit "$doctor_status"
fi

SERVICE_FILE=$(find "$XDG_CONFIG_HOME/systemd/user" -maxdepth 1 -name 'runtimed*.service' -print -quit 2>/dev/null || true)
if [[ -z "$SERVICE_FILE" ]]; then
  echo "daemon doctor did not write a user systemd service file" >&2
  exit 1
fi

echo "=== user systemd service ==="
cat "$SERVICE_FILE"
echo

if ! grep -Fq "ExecStart=" "$SERVICE_FILE"; then
  echo "service file has no ExecStart" >&2
  exit 1
fi

if ! grep -Fq "$XDG_DATA_HOME" "$SERVICE_FILE"; then
  echo "service file does not point at durable per-user data" >&2
  exit 1
fi

if ! grep -Fq "Environment=HOME=$HOME" "$SERVICE_FILE"; then
  echo "service file does not preserve HOME" >&2
  exit 1
fi
