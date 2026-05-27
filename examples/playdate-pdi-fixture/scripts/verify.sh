#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HARNESS="${PLAYDATE_HARNESS:-$HOME/codex/playdate-harness}"
SDK="${PLAYDATE_SDK:-${PLAYDATE_SDK_PATH:-$HOME/Developer/PlaydateSDK}}"
NAME="CloudSnapshotPdiFixture"
BUNDLE_ID="com.nteract.cloud-snapshot-pdi-fixture"

if [[ ! -x "$SDK/bin/pdc" ]]; then
  echo "Playdate pdc not found at $SDK/bin/pdc" >&2
  echo "Set PLAYDATE_SDK_PATH or PLAYDATE_SDK to the Playdate SDK root." >&2
  exit 1
fi

if [[ ! -x "$HARNESS/scripts/compile.py" || ! -x "$HARNESS/scripts/sim_autotest.py" ]]; then
  echo "Playdate harness scripts not found under $HARNESS/scripts" >&2
  echo "Set PLAYDATE_HARNESS to the playdate-harness checkout." >&2
  exit 1
fi

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
