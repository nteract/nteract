#!/usr/bin/env bash
# CI/host entry point for the runtime-peer image smoke test.
#
# Usage: runtime-peer-image-smoke.sh <image-ref> [expected-version-substring]
#
# Builds nothing: pass an already-built image reference (the release workflow
# builds the image first, then calls this). Runs the in-image smoke script
# (images/runtime-peer/smoke.sh, baked into the image at
# /usr/local/share/nteract/smoke.sh) inside a fresh container as the image's
# non-root user.
#
# Follows the style of the other scripts/ci/*-smoke.sh entries.
set -euo pipefail

IMAGE="${1:?usage: runtime-peer-image-smoke.sh <image-ref> [expected-version]}"
EXPECTED_VERSION="${2:-}"

EXTRA_ARGS=()
if [ -n "$EXPECTED_VERSION" ]; then
    EXTRA_ARGS+=("$EXPECTED_VERSION")
fi

echo "== [image-smoke] running smoke inside ${IMAGE}"
# --entrypoint bash: the image's default entrypoint is `runtimed`; the smoke
# needs a shell. The smoke script is baked into the image at
# /usr/local/share/nteract/smoke.sh, so no volume mounts are needed.
docker run --rm --init --entrypoint bash "$IMAGE" \
    /usr/local/share/nteract/smoke.sh "${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}"

echo "== [image-smoke] ${IMAGE} passed"
