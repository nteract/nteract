#!/usr/bin/env bash
# CI-only reduced reproduction. Never substitutes for the ordinary image smoke.
set -euo pipefail
[ "${GITHUB_ACTIONS:-}" = true ] || { echo "CI-only diagnostic" >&2; exit 2; }

PROBE_FILE="$(mktemp)"
SOCKET_DIR="${HOME}/.runt-gdb-probe"
export RUNTIMED_SOCKET_PATH="${SOCKET_DIR}/runtimed.sock"
mkdir -p "$SOCKET_DIR"
cat > "$PROBE_FILE" <<'PY'
import asyncio

import runtimed


async def main() -> None:
    assert await asyncio.wait_for(runtimed.Client().ping(), timeout=10), "daemon ping failed"


asyncio.run(main())
print("[gdb-probe] ping returned; interpreter shutdown follows")
PY

# Keep this function independently testable with a fake debugger. Each sample
# is mandatory; a stopped signal, failed ping, or tracing error stops the loop.
run_probes() {
    for attempt in $(seq 1 20); do
        echo "gdb binding exit probe ${attempt}/20 starting"
        gdb --batch --nx --return-child-result \
            -ex 'set pagination off' \
            -ex 'set disable-randomization off' \
            -ex 'set print thread-events off' \
            -ex run \
            -ex 'thread apply all backtrace' \
            --args python3 -X faulthandler -u "$PROBE_FILE" || {
                status=$?
                echo "gdb binding exit probe ${attempt}/20 failed (debugger exit: ${status})" >&2
                return "$status"
            }
        echo "gdb binding exit probe ${attempt}/20 exited cleanly"
    done
}

runtimed &
DAEMON_PID=$!
cleanup() {
    kill "$DAEMON_PID" 2>/dev/null || true
    wait "$DAEMON_PID" 2>/dev/null || true
    rm -f "$PROBE_FILE"
}
trap cleanup EXIT
for _ in $(seq 1 120); do
    [ -S "$RUNTIMED_SOCKET_PATH" ] && break
    kill -0 "$DAEMON_PID" 2>/dev/null || { echo "diagnostic daemon exited" >&2; exit 1; }
    sleep 1
done
[ -S "$RUNTIMED_SOCKET_PATH" ] || { echo "diagnostic socket missing" >&2; exit 1; }
gdb --version
run_probes
