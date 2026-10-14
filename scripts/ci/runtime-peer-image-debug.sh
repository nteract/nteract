#!/usr/bin/env bash
# PR-CI-only debugger derivative. The ordinary image smoke remains a separate,
# authoritative gate, and a successful diagnostic can never erase its failure.
set -euo pipefail
[ "${GITHUB_ACTIONS:-}" = true ] || { echo "CI-only diagnostic" >&2; exit 2; }
IMAGE="${1:?usage: runtime-peer-image-debug.sh <built-image> <output-dir>}"
OUTPUT_DIR="${2:?missing output directory}"
DEBUG_IMAGE="${IMAGE}-debug"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$OUTPUT_DIR"
OUTPUT_DIR="$(cd "$OUTPUT_DIR" && pwd)"
cp "$SCRIPT_DIR/runtime-peer-binding-exit-gdb.sh" "$OUTPUT_DIR/probe.sh"

# Read package paths without importing runtimed/native code. Interpreter,
# libpython and extension identity must match before any diagnostic RPC runs.
cat > "$OUTPUT_DIR/identity.py" <<'PY'
import hashlib
import json
import re
import subprocess
import sys
import sysconfig
from pathlib import Path


def digest(path):
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


extensions = list((Path(sysconfig.get_path("platlib")) / "runtimed").glob("_internals*.so"))
assert len(extensions) == 1, f"expected one native binding, found {extensions}"
files = {
    "interpreter": Path(sys.executable).resolve(),
    "libpython": (Path(sysconfig.get_config_var("LIBDIR")) / sysconfig.get_config_var("LDLIBRARY")).resolve(),
    "binding": extensions[0].resolve(),
}
if sys.argv[1] == "identity":
    result = {
        "python_version": sys.version,
        "files": {name: {"path": str(path), "sha256": digest(path)} for name, path in files.items()},
    }
else:
    assert sys.argv[1] == "libraries"
    libraries = set()
    for path in files.values():
        output = subprocess.run(["ldd", str(path)], check=True, capture_output=True, text=True).stdout
        libraries.update(Path(match).resolve() for match in re.findall(r"(/[^\s()]+)", output))
    result = {str(path): digest(path) for path in sorted(libraries)}
print(json.dumps(result, sort_keys=True, indent=2))
PY

snapshot() {
    local image="$1" label="$2"
    for kind in identity libraries; do
        docker run --rm --entrypoint python3 \
            --mount "type=bind,src=${OUTPUT_DIR},dst=/diagnostics,readonly" \
            "$image" /diagnostics/identity.py "$kind" > "$OUTPUT_DIR/${label}-${kind}.json"
    done
    docker run --rm --entrypoint dpkg-query "$image" -W '-f=${binary:Package}\t${Version}\n' \
        | LC_ALL=C sort > "$OUTPUT_DIR/${label}-packages.txt"
}
record_difference() {
    local kind="$1" extension="$2" status
    if diff -u "$OUTPUT_DIR/ordinary-${kind}.${extension}" "$OUTPUT_DIR/debug-${kind}.${extension}" \
        > "$OUTPUT_DIR/${kind}.diff"; then
        echo "diagnostic ${kind}: unchanged"
    else
        status=$?
        [ "$status" -eq 1 ] || return "$status"
        cat "$OUTPUT_DIR/${kind}.diff"
    fi
}

snapshot "$IMAGE" ordinary
# This unpushed derivative is local to the PR job. Do not modify the shipped
# Dockerfile or relax container/host tracing policy if GDB cannot run.
docker build --pull=false --tag "$DEBUG_IMAGE" --file - "$OUTPUT_DIR" <<DOCKERFILE
FROM ${IMAGE}
USER root
RUN apt-get update && apt-get install -y --no-install-recommends --no-upgrade gdb && rm -rf /var/lib/apt/lists/*
USER runt
DOCKERFILE
snapshot "$DEBUG_IMAGE" debug
cat "$OUTPUT_DIR/ordinary-identity.json"
if ! cmp -s "$OUTPUT_DIR/ordinary-identity.json" "$OUTPUT_DIR/debug-identity.json"; then
    echo "diagnostic changed interpreter/libpython/native binding identity; refusing to run" >&2
    exit 1
fi
record_difference packages txt
record_difference libraries json

echo "== [image-debug] diagnostic derivative ${DEBUG_IMAGE}; ordinary image gate remains separate"
docker run --rm --init --entrypoint bash -e GITHUB_ACTIONS=true \
    --mount "type=bind,src=${OUTPUT_DIR},dst=/diagnostics,readonly" \
    "$DEBUG_IMAGE" /diagnostics/probe.sh 2>&1 | tee "$OUTPUT_DIR/gdb-probe.log"
