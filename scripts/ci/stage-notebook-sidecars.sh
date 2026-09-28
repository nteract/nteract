#!/usr/bin/env bash
set -euo pipefail

target=${1:?usage: stage-notebook-sidecars.sh <Rust target triple>}
suffix=""
if [[ "$target" == *windows* ]]; then
  suffix=".exe"
fi

mkdir -p crates/notebook/binaries target/release/binaries
for binary in runtimed runt nteract-cli nteract-mcp; do
  for destination in crates/notebook/binaries target/release/binaries; do
    cp "target/release/$binary$suffix" "$destination/$binary-$target$suffix"
  done
done
