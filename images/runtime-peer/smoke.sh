#!/usr/bin/env bash
# Smoke test for the nteract runtime-peer image. Runs INSIDE the container
# (see scripts/ci/runtime-peer-image-smoke.sh for the host-side entry point).
#
# Tiers mirror the container contract documented in
# images/runtime-peer/README.md ("Container contract summary"):
#   0. Container interface prechecks: non-root user, PATH binaries, package
#      parity with UV_BASE_PACKAGES, writable HOME, version stamp.
#   1. End-to-end daemon execution: start the daemon, use the runtimed Python
#      bindings to create a notebook, create cells in the Automerge document,
#      execute them by cell_id, and assert stream output, a binary (blob-store)
#      rich output, and a widget display. (PyPI is reachable for the daemon's
#      uv env build; no cloud is involved.)
#   2. current_python launch-shape parity: with the launcher cache materialized
#      by tier 1's daemon, launch the vendored nteract_kernel_launcher with the
#      exact command line and PYTHONPATH injection the agent's current_python
#      arm uses (crates/runtimed/src/jupyter_kernel.rs) and assert the kernel
#      starts and heartbeats.
set -euo pipefail

EXPECTED_VERSION="${1:-}"
SOCKET_DIR="${HOME}/.runt-smoke"
SOCKET_PATH="${SOCKET_DIR}/runtimed.sock"
export RUNTIMED_SOCKET_PATH="${SOCKET_PATH}"

step() { printf '\n== [smoke] %s\n' "$*"; }
fail() { printf '== [smoke] FAIL: %s\n' "$*" >&2; exit 1; }

# --- Tier 0: container interface prechecks ---------------------------------

step "tier 0: container interface prechecks"

[ "$(id -u)" = "1000" ] || fail "expected uid 1000 (runt), got $(id -u)"
for bin in runtimed runt nteract python3 uv; do
    command -v "$bin" >/dev/null || fail "$bin not on PATH"
done
[ -w "$HOME" ] || fail "HOME ($HOME) is not writable (daemon base dir needs it)"

runtimed --version >/dev/null || fail "runtimed --version failed"
RUNTIMED_VERSION="$(runtimed --version 2>/dev/null || true)"
echo "runtimed reports: ${RUNTIMED_VERSION}"
if [ -n "$EXPECTED_VERSION" ]; then
    # Boundary-safe match: "runtimed 2.7.6" exactly, or "runtimed 2.7.6+<hash>"
    # (the `+` in the pattern is literal, so 2.7.60 can never false-pass).
    case "$RUNTIMED_VERSION" in
        "runtimed ${EXPECTED_VERSION}" | "runtimed ${EXPECTED_VERSION}"+*) ;;
        *) fail "version parity: expected '${EXPECTED_VERSION}' in '${RUNTIMED_VERSION}'" ;;
    esac
fi

python3 - <<'PY' || fail "image Python package parity check failed"
import importlib
import sys

for module in ("ipykernel", "ipywidgets", "anywidget", "nbformat", "pyarrow"):
    importlib.import_module(module)

import pyarrow

major = int(pyarrow.__version__.split(".")[0])
assert major >= 14, f"pyarrow>=14 required, found {pyarrow.__version__}"
print(f"package parity ok (pyarrow {pyarrow.__version__})")
PY

# --- Tier 1: daemon + Python bindings end-to-end ---------------------------

step "tier 1: daemon execution via Python bindings"

mkdir -p "$SOCKET_DIR"
runtimed &
DAEMON_PID=$!
cleanup() {
    [ -n "${KERNEL_PID:-}" ] && kill "$KERNEL_PID" 2>/dev/null || true
    [ -n "${CONN_FILE:-}" ] && rm -f "$CONN_FILE"
    kill "$DAEMON_PID" 2>/dev/null || true
    wait "$DAEMON_PID" 2>/dev/null || true
}
trap cleanup EXIT

for _ in $(seq 1 120); do
    [ -S "$SOCKET_PATH" ] && break
    kill -0 "$DAEMON_PID" 2>/dev/null || fail "daemon exited before opening ${SOCKET_PATH}"
    sleep 1
done
[ -S "$SOCKET_PATH" ] || fail "daemon socket never appeared at ${SOCKET_PATH}"
echo "daemon socket ready at ${SOCKET_PATH}"

python3 - <<'PY' || fail "daemon execution tier failed"
import asyncio
import runtimed

PNG_BYTES = bytes.fromhex(
    "89504e470d0a1a0a0000000d494844520000000100000001080600000"
    "01f15c4890000000d4944415478da63f8cfc0f01f00050001ff56c72f"
    "0d0000000049454e44ae426082"
)


def collect_mimes(result) -> set:
    mimes: set = set()
    for out in getattr(result, "outputs", None) or []:
        data = getattr(out, "data", None)
        if isinstance(data, dict):
            mimes.update(data.keys())
        for attr in ("mime_type", "kind", "output_type"):
            value = getattr(out, attr, None)
            if isinstance(value, str):
                mimes.add(value)
    return mimes


async def main() -> None:
    client = runtimed.Client()

    async with await client.create_notebook() as notebook:
        # Plain stream output, executed via the synced doc (cell_id).
        cell = await notebook.cells.create("print('hello from image')")
        result = await cell.run(timeout_secs=300)
        assert result.success, f"execution failed: {getattr(result, 'error', None)}"
        assert "hello from image" in (result.stdout or ""), (
            f"stdout missing expected marker, got: {result.stdout!r}"
        )
        print("stream output ok")

        # Binary rich output exercises the blob-store path (image/png).
        cell = await notebook.cells.create(
            "from IPython.display import Image\n"
            f"Image(bytes.fromhex('{PNG_BYTES.hex()}'), format='png')"
        )
        result = await cell.run(timeout_secs=300)
        assert result.success, f"binary output cell failed: {getattr(result, 'error', None)}"
        mimes = collect_mimes(result)
        png_seen = "image/png" in mimes or any(
            isinstance(getattr(out, "data", None), (bytes, bytearray))
            and bytes(getattr(out, "data")).startswith(b"\x89PNG")
            for out in getattr(result, "outputs", None) or []
        )
        assert png_seen, f"no image/png output observed (mimes: {mimes or 'none'})"
        print(f"binary rich output ok (mimes: {sorted(mimes)})")

        # Widget display exercises the ipywidgets comm path kernel-side.
        cell = await notebook.cells.create(
            "import ipywidgets as widgets\n"
            "from IPython.display import display\n"
            "display(widgets.IntSlider(value=5))\n"
            "print('widget-ok')"
        )
        result = await cell.run(timeout_secs=300)
        assert result.success, f"widget cell failed: {getattr(result, 'error', None)}"
        assert "widget-ok" in (result.stdout or ""), (
            f"widget cell stdout missing marker: {result.stdout!r}"
        )
        print("widget comm display ok")


asyncio.run(main())
print("tier 1 ok")
PY

# --- Tier 2: current_python launch-shape parity ----------------------------

step "tier 2: current_python launch-shape parity"

# Pick the NEWEST launcher cache: if a provider mounts a home that contains
# stale launcher caches from earlier runs, an arbitrary `find | head -1`
# could select one that does not belong to this daemon run.
LAUNCHER_DIR="$(find "$HOME/.cache" -type d -name nteract_kernel_launcher 2>/dev/null -exec stat -c '%Y %n' {} + \
    | sort -rn | head -1 | cut -d' ' -f2-)"
[ -n "$LAUNCHER_DIR" ] || fail "nteract_kernel_launcher cache not found after daemon launch"
PYTHONPATH_PARENT="$(dirname "$LAUNCHER_DIR")"
echo "launcher cache at ${LAUNCHER_DIR}"

CONN_FILE="$(mktemp)"
HEARTBEAT_PORT="$(python3 - "$CONN_FILE" <<'PY'
import json
import socket
import sys
import uuid


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


ports = {name: free_port() for name in ("shell", "iopub", "stdin", "control", "hb")}
conn = {
    f"{name}_port": port for name, port in ports.items()
} | {
    "ip": "127.0.0.1",
    # Mirrors the daemon: the uv:current_python arm generates a per-launch
    # random key (jupyter_kernel.rs) and passes it via the connection file.
    "key": str(uuid.uuid4()),
    "transport": "tcp",
    "kernel_name": "python3",
}
with open(sys.argv[1], "w") as fh:
    json.dump(conn, fh)
print(ports["hb"])
PY
)"
[ -n "$HEARTBEAT_PORT" ] || fail "failed to allocate ports for the connection file"

# Launch shape mirrors the uv:current_python arm
# (crates/runtimed/src/jupyter_kernel.rs): -Xfrozen_modules=off, the vendored
# launcher module, -f <connection file> (which carries the random key), and
# the launcher parent on PYTHONPATH. Known accepted race: a port reserved
# here can in principle be claimed by another process before the kernel
# binds it (two smoke runs observed passing; probability negligible on a
# single-tenant loopback container — if it ever bites, regenerate the conn
# file and retry once).
PYTHONPATH="$PYTHONPATH_PARENT" python3 -Xfrozen_modules=off -m nteract_kernel_launcher \
    -f "$CONN_FILE" &
KERNEL_PID=$!

python3 - "$HEARTBEAT_PORT" "$KERNEL_PID" <<'PY'
import os
import socket
import sys
import time

hb_port, kernel_pid = int(sys.argv[1]), int(sys.argv[2])
deadline = time.time() + 60
while time.time() < deadline:
    try:
        with socket.create_connection(("127.0.0.1", hb_port), timeout=1):
            break
    except OSError:
        try:
            os.kill(kernel_pid, 0)
        except ProcessLookupError:
            print("kernel process died before heartbeat", file=sys.stderr)
            sys.exit(1)
        time.sleep(0.5)
else:
    print("kernel heartbeat never opened", file=sys.stderr)
    sys.exit(1)
print("kernel heartbeat ok")
PY

# Kernel stays alive after handshake
sleep 2
kill -0 "$KERNEL_PID" 2>/dev/null || fail "kernel exited after heartbeat"
kill "$KERNEL_PID" 2>/dev/null || true
wait "$KERNEL_PID" 2>/dev/null || true
rm -f "$CONN_FILE"

step "ALL SMOKE TIERS PASSED"
