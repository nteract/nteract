#!/bin/bash
set -euo pipefail
app="$(cd "$(dirname "$0")/../.." && pwd)"
app="${EVAL_PAGES_APP:-$app}"
port="${PAGES_PORT:-9938}"
catalog_port="${PAGES_CATALOG_PORT:-9447}"
catalog="http://127.0.0.1:$catalog_port"
curl -fsS "$catalog/catalog.json" >/dev/null
if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null; then
  echo "Port $port is occupied. Choose a free port for the eval host." >&2
  exit 1
fi
run=$(mktemp -d "${TMPDIR:-/tmp}/pages-eval-host.XXXXXX")
echo "Eval host directory: $run"
mkdir -p "$run/scripts" "$run/.output-dist/catalog" "$run/dist"
cp "$app/scripts/dev.mjs" "$run/scripts/"
cp "$app/.output-dist/catalog/current-$catalog_port" "$run/.output-dist/catalog/"
rsync -a --exclude='.celld' --exclude='.dev.vars' "$app/dist/" "$run/dist/"
export PAGES_PORT="$port" PAGES_OUTPUT_FRAME_URL="$catalog/frame/v2/" PAGES_E2E_ONLY=true
exec node "$run/scripts/dev.mjs"
