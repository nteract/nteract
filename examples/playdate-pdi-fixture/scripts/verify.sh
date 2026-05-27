#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HARNESS="/Users/kyle/codex/playdate-harness"
SDK="/Users/kyle/Developer/PlaydateSDK"
NAME="CloudSnapshotPdiFixture"
BUNDLE_ID="com.nteract.cloud-snapshot-pdi-fixture"

python3 "$ROOT/scripts/generate_fixture_png.py"
python3 "$HARNESS/scripts/check_sprites.py" "$ROOT/Source/assets/cloud-figure.png"
python3 "$HARNESS/scripts/compile.py" --project "$ROOT" --name "$NAME" --sdk "$SDK"

PDI="$ROOT/build/$NAME.pdx/assets/cloud-figure.pdi"
if [[ ! -s "$PDI" ]]; then
  echo "missing generated PDI: $PDI" >&2
  exit 1
fi
python3 - <<'PY' "$PDI"
from pathlib import Path
import sys
p = Path(sys.argv[1])
print(f"pdi={p}")
print(f"pdi_size={p.stat().st_size}")
PY

python3 "$HARNESS/scripts/sim_autotest.py" \
  --project "$ROOT" \
  --name "$NAME" \
  --bundle-id "$BUNDLE_ID" \
  --scenario default \
  --sdk "$SDK" \
  --out "$ROOT/qa/autotest-result.txt"

echo "telemetry=$ROOT/qa/autotest-result.txt"
echo "source_png=$ROOT/Source/assets/cloud-figure.png"
echo "compiled_pdi=$PDI"
