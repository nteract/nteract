#!/usr/bin/env bash
# Linux container that can pair with this worktree's local notebook-cloud worker,
# so the "Connect a machine" commands from the Workstations panel can be pasted
# in verbatim.
#
#   scripts/local-workstation-container.sh up      # bridge + container, then exit
#   scripts/local-workstation-container.sh shell   # interactive shell in it
#   scripts/local-workstation-container.sh status
#   scripts/local-workstation-container.sh down
#
# Requires `pnpm --dir apps/notebook-cloud dev` already running.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${NTERACT_WORKSTATION_IMAGE:-ubuntu:22.04}"
PLATFORM="${NTERACT_WORKSTATION_PLATFORM:-linux/amd64}"

read -r WRANGLER_PORT PORT_OFFSET <<<"$(
  cd "$REPO_ROOT" && node -e '
import("./apps/notebook-cloud/scripts/local-dev.mjs").then((m) => {
  const ports = m.notebookCloudDevPorts();
  process.stdout.write(
    `${ports.port} ${ports.port - m.WRANGLER_HTTP_PORT_BASE}\n`,
  );
});
'
)"
# Above the wrangler http (45000+) and inspector (46000+) ranges.
BRIDGE_PORT=$((47000 + PORT_OFFSET))
CONTAINER="nteract-workstation-${PORT_OFFSET}"
BRIDGE_PIDFILE="${TMPDIR:-/tmp}/${CONTAINER}-bridge.pid"

log() { printf '\033[36m==>\033[0m %s\n' "$*"; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

bridge_running() {
  [[ -f "$BRIDGE_PIDFILE" ]] && kill -0 "$(cat "$BRIDGE_PIDFILE")" 2>/dev/null
}

require_docker() {
  if ! docker info >/dev/null 2>&1; then
    if command -v colima >/dev/null 2>&1; then
      log "starting colima (vz + rosetta, needed for $PLATFORM)"
      colima start --vm-type vz --vz-rosetta --cpu 4 --memory 6 --disk 40
      docker context use colima >/dev/null
    else
      die "no docker daemon. Start Docker Desktop, or install colima."
    fi
  fi
}

# The worker binds loopback only, so a container cannot reach it directly.
# Bridge it onto the VM-visible interface, then bridge it back to loopback
# inside the container so the panel's copied host:port needs no rewriting.
start_bridge() {
  curl -fsS -o /dev/null --max-time 5 "http://127.0.0.1:${WRANGLER_PORT}/" \
    || die "nothing serving 127.0.0.1:${WRANGLER_PORT} — run: pnpm --dir apps/notebook-cloud dev"
  command -v socat >/dev/null || die "socat not found — brew install socat"
  if bridge_running; then
    log "host bridge already up on :${BRIDGE_PORT}"
    return
  fi
  # Fully detached: an inherited stdout would keep `... | tail` pipelines open.
  socat "TCP-LISTEN:${BRIDGE_PORT},bind=0.0.0.0,reuseaddr,fork" \
    "TCP:127.0.0.1:${WRANGLER_PORT}" </dev/null >/dev/null 2>&1 &
  echo $! >"$BRIDGE_PIDFILE"
  disown
  log "host bridge :${BRIDGE_PORT} -> 127.0.0.1:${WRANGLER_PORT} (pid $(cat "$BRIDGE_PIDFILE"))"
}

stop_bridge() {
  if bridge_running; then
    kill "$(cat "$BRIDGE_PIDFILE")" 2>/dev/null || true
    log "stopped host bridge"
  fi
  rm -f "$BRIDGE_PIDFILE"
}

# The `current_python` policy launches kernels against this interpreter as-is
# with package management disabled, so ipykernel must already be importable —
# otherwise every launch dies with ModuleNotFoundError and the panel shows a
# raw traceback with no remediation.
ensure_ipykernel() {
  if docker exec "$CONTAINER" python3 -c 'import ipykernel' 2>/dev/null; then
    return
  fi
  log "installing ipykernel into the container's python3"
  docker exec "$CONTAINER" python3 -m pip install --quiet ipykernel
}

start_container() {
  if [[ -n "$(docker ps -aq -f "name=^${CONTAINER}$")" ]]; then
    docker start "$CONTAINER" >/dev/null
    log "container ${CONTAINER} already exists (started)"
  else
    log "creating ${CONTAINER} (${IMAGE}, ${PLATFORM})"
    docker run -d --name "$CONTAINER" --platform "$PLATFORM" \
      --add-host "cloud-host:host-gateway" \
      -e "NTERACT_CLOUD_URL=http://127.0.0.1:${WRANGLER_PORT}" \
      "$IMAGE" sleep infinity >/dev/null
    log "installing curl / socat / tmux"
    docker exec "$CONTAINER" bash -lc '
      set -eu
      export DEBIAN_FRONTEND=noninteractive
      apt-get update -qq
      apt-get install -y -qq --no-install-recommends \
        ca-certificates curl socat tmux procps \
        python3 python3-venv python3-pip >/dev/null
    '
  fi

  ensure_ipykernel

  log "in-container loopback bridge 127.0.0.1:${WRANGLER_PORT} -> host"
  # Probe with curl, not pgrep -f: the pattern would match this bash -lc itself.
  if ! docker exec "$CONTAINER" curl -fsS -o /dev/null --max-time 3 \
    "http://127.0.0.1:${WRANGLER_PORT}/" 2>/dev/null; then
    docker exec -d "$CONTAINER" socat \
      "TCP-LISTEN:${WRANGLER_PORT},bind=127.0.0.1,reuseaddr,fork" \
      "TCP:host.docker.internal:${BRIDGE_PORT}"
  fi
  for _ in $(seq 20); do
    if docker exec "$CONTAINER" curl -fsS -o /dev/null --max-time 3 \
      "http://127.0.0.1:${WRANGLER_PORT}/" 2>/dev/null; then
      log "container reaches the worker at http://127.0.0.1:${WRANGLER_PORT}"
      return
    fi
    sleep 0.5
  done
  die "container could not reach the worker; try: docker logs ${CONTAINER}"
}

install_nteract() {
  if docker exec "$CONTAINER" test -x /root/.local/bin/runt; then
    log "nteract already installed ($(docker exec "$CONTAINER" \
      /root/.local/bin/runt --version))"
    return
  fi
  log "installing nteract headless (linux-x64 release, runs under Rosetta)"
  docker exec "$CONTAINER" bash -lc \
    "curl --proto '=https' --tlsv1.2 -sSf https://sh.nteract.io | bash -s -- --headless" \
    >/dev/null
  # /etc/profile.d, not ~/.bashrc: `bash -l` sources the former, not the latter.
  docker exec "$CONTAINER" bash -c \
    'printf "export PATH=\"\$HOME/.local/bin:\$PATH\"\n" >/etc/profile.d/nteract.sh'
  log "installed $(docker exec "$CONTAINER" /root/.local/bin/runt --version)"
}

# Avoid `| grep -q`: it exits early, SIGPIPEs runt, and pipefail sees a failure.
daemon_running() {
  local status
  status="$(docker exec "$CONTAINER" /root/.local/bin/runt daemon status 2>/dev/null || true)"
  [[ "$status" == *"Daemon running:"*"yes"* ]]
}

# `runt daemon start` needs systemd, which this container has no init for.
start_daemon() {
  if daemon_running; then
    log "daemon already running"
    return
  fi
  log "starting 'runtimed run' in the background (log: /tmp/runtimed.log)"
  docker exec -d "$CONTAINER" bash -lc \
    '/root/.local/bin/runtimed run >/tmp/runtimed.log 2>&1'
  for _ in $(seq 30); do
    if daemon_running; then
      log "daemon up"
      return
    fi
    sleep 1
  done
  log "daemon did not report running — check: docker exec ${CONTAINER} cat /tmp/runtimed.log"
}

case "${1:-up}" in
  up)
    require_docker
    start_bridge
    start_container
    install_nteract
    start_daemon
    cat <<EOF

Ready. Get a shell with:

  scripts/local-workstation-container.sh shell

Then paste the panel's commands as-is; http://127.0.0.1:${WRANGLER_PORT} resolves
to the worker. Mint the pairing code from the Workstations panel first.

  runt workstation connect http://127.0.0.1:${WRANGLER_PORT} --code XXXX-XXXX-XXXX
  runt workstation run --python-path "\$(command -v python3)"

nteract is already installed and PATH is set, so skip the installer and export
steps in the panel. There is no systemd in the container, so 'runt daemon start'
and 'runt workstation service install' both fail — this script already started
'runtimed run' (log: /tmp/runtimed.log); use foreground 'runt workstation run'.
EOF
    ;;
  shell) exec docker exec -it "$CONTAINER" bash -l ;;
  status)
    bridge_running && log "host bridge up (:${BRIDGE_PORT})" || log "host bridge down"
    docker ps -a -f "name=^${CONTAINER}$" \
      --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}'
    ;;
  logs) exec docker logs -f "$CONTAINER" ;;
  down)
    stop_bridge
    docker rm -f "$CONTAINER" >/dev/null 2>&1 && log "removed ${CONTAINER}" || true
    ;;
  *) die "usage: $0 {up|shell|status|logs|down}" ;;
esac
