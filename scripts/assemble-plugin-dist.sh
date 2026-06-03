#!/usr/bin/env bash
# Assemble one channel's slice of the nteract plugin distribution repo.
# Run once per release; the other channel's slice is preserved.
#
# Inputs:
#   --channel {stable|nightly}     which plugin this release is building
#   --binaries-dir <path>          directory containing nteract-mcp-<target>{,.exe}
#   --out-dir <path>               existing distribution checkout (merged into)
#
# Layout in the distribution repo (one repo, both channels):
#   .claude-plugin/marketplace.json               — Claude marketplace entries
#   .agents/plugins/marketplace.json              — Codex marketplace entries
#   plugins/nteract/                              — stable channel
#     .mcp.json, .codex-mcp.json, .claude-plugin/, .codex-plugin/, skills/, bin/
#   plugins/nightly/                              — nightly channel
#     .mcp.json, .codex-mcp.json, .claude-plugin/, .codex-plugin/, skills/, bin/
#   README.md
#
# Claude user install commands (both valid against the same marketplace):
#   /plugin install nteract@nteract      # stable
#   /plugin install nightly@nteract      # nightly
#
# This script only writes to its own channel's plugins/<name>/ subtree
# plus the channel's marketplace.json entry. README.md and the other
# channel's plugin tree are left untouched so serial stable+nightly
# releases don't stomp each other.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

channel=""
binaries_dir=""
out_dir=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --channel) channel="$2"; shift 2 ;;
    --binaries-dir) binaries_dir="$2"; shift 2 ;;
    --out-dir) out_dir="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,25p' "$0"
      exit 0
      ;;
    *)
      echo "unknown arg: $1" >&2
      exit 2
      ;;
  esac
done

[[ -n "$channel" ]] || { echo "--channel required" >&2; exit 2; }
[[ -n "$binaries_dir" ]] || { echo "--binaries-dir required" >&2; exit 2; }
[[ -n "$out_dir" ]] || { echo "--out-dir required" >&2; exit 2; }

case "$channel" in
  stable)
    plugin_name="nteract"
    source_subdir="nteract"
    plugin_description="nteract notebooks."
    codex_mcp_server="nteract-notebook"
    ;;
  nightly)
    plugin_name="nightly"
    source_subdir="nightly"
    plugin_description="nteract notebooks (nightly channel)."
    codex_mcp_server="nightly"
    ;;
  *)
    echo "unknown channel '$channel' (expected stable|nightly)" >&2
    exit 2
    ;;
esac

source_plugin="$REPO_ROOT/plugins/$source_subdir"
[[ -d "$source_plugin" ]] || { echo "source plugin not found: $source_plugin" >&2; exit 1; }
plugin_version="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$source_plugin/.codex-plugin/plugin.json")"

# Per-release targets.
declare -a TARGETS=(
  "aarch64-apple-darwin"
  "x86_64-apple-darwin"
  "x86_64-unknown-linux-gnu"
  "x86_64-pc-windows-msvc"
)

# Verify every binary is present before we touch out_dir.
missing=()
for t in "${TARGETS[@]}"; do
  if [[ "$t" == *windows* ]]; then
    candidate="$binaries_dir/nteract-mcp-$t.exe"
  else
    candidate="$binaries_dir/nteract-mcp-$t"
  fi
  [[ -f "$candidate" ]] || missing+=("$candidate")
done
if (( ${#missing[@]} > 0 )); then
  echo "missing binaries:" >&2
  printf '  %s\n' "${missing[@]}" >&2
  exit 1
fi

# Prepare the channel's plugin subtree (wipe + recreate). The other
# channel's tree at out_dir/plugins/<other>/ is untouched.
plugin_dir="$out_dir/plugins/$plugin_name"
rm -rf "$plugin_dir"
mkdir -p "$plugin_dir/bin"

# Copy plugin manifests + skills verbatim.
for item in .mcp.json .codex-mcp.json .claude-plugin .codex-plugin skills assets; do
  if [[ -e "$source_plugin/$item" ]]; then
    cp -R "$source_plugin/$item" "$plugin_dir/"
  fi
done

# Drop the source-repo .gitignore from bin/ (distribution repo tracks
# binaries). It'll be regenerated on next clean, this is defensive.
rm -f "$plugin_dir/bin/.gitignore"

# Copy binaries with target-suffixed names.
for t in "${TARGETS[@]}"; do
  if [[ "$t" == *windows* ]]; then
    src="$binaries_dir/nteract-mcp-$t.exe"
    dest="$plugin_dir/bin/nteract-mcp-$t.exe"
  else
    src="$binaries_dir/nteract-mcp-$t"
    dest="$plugin_dir/bin/nteract-mcp-$t"
  fi
  cp "$src" "$dest"
  chmod 0755 "$dest"
done

# Copy the two dispatch wrappers. Unix (POSIX sh) + Windows (batch).
# Both `exec`/`call` the right sibling binary — no long-lived parent,
# signals and exit codes are transparent.
cp "$REPO_ROOT/scripts/plugin-dispatch-wrapper.sh" \
   "$plugin_dir/bin/nteract-mcp"
chmod 0755 "$plugin_dir/bin/nteract-mcp"

cp "$REPO_ROOT/scripts/plugin-dispatch-wrapper.cmd" \
   "$plugin_dir/bin/nteract-mcp.cmd"

expected_files=(
  "$plugin_dir/bin/nteract-mcp"
  "$plugin_dir/bin/nteract-mcp-aarch64-apple-darwin"
  "$plugin_dir/bin/nteract-mcp-x86_64-apple-darwin"
  "$plugin_dir/bin/nteract-mcp-x86_64-unknown-linux-gnu"
  "$plugin_dir/bin/nteract-mcp-x86_64-pc-windows-msvc.exe"
  "$plugin_dir/bin/nteract-mcp.cmd"
)

missing_dist=()
for expected_file in "${expected_files[@]}"; do
  [[ -f "$expected_file" ]] || missing_dist+=("$expected_file")
done
if (( ${#missing_dist[@]} > 0 )); then
  echo "assembled plugin is missing required files:" >&2
  printf '  %s\n' "${missing_dist[@]}" >&2
  exit 1
fi

if [[ -e "$plugin_dir/bin/.gitignore" ]]; then
  echo "assembled plugin unexpectedly retained source-only bin/.gitignore" >&2
  exit 1
fi

python3 - "$plugin_dir/.codex-mcp.json" "$codex_mcp_server" <<'PY'
import json
import sys

path, expected_server = sys.argv[1:3]
with open(path) as f:
    data = json.load(f)

servers = set(data)
if servers != {expected_server}:
    print(
        f"{path}: expected only Codex MCP server {expected_server!r}, got {sorted(servers)!r}",
        file=sys.stderr,
    )
    sys.exit(1)

server = data[expected_server]
if server.get("command") != "./bin/nteract-mcp":
    print(
        f"{path}: {expected_server} must launch ./bin/nteract-mcp",
        file=sys.stderr,
    )
    sys.exit(1)
PY

# Generate / update marketplace files. Read existing, update or insert
# this channel's entry, rewrite. Both stable and nightly publishers run
# this logic; the invariant is that stable owns the "nteract" plugin
# entry and nightly owns the "nightly" plugin entry — neither touches
# the other. Marketplace "name" is always "nteract" (the catalog).
marketplace_json="$out_dir/.claude-plugin/marketplace.json"
mkdir -p "$out_dir/.claude-plugin"

python3 - "$marketplace_json" "$plugin_name" "./plugins/$plugin_name" "$plugin_description" "$plugin_version" <<'PY'
import json
import os
import sys

path, plugin_name, source, description, plugin_version = sys.argv[1:6]

try:
    with open(path) as f:
        data = json.load(f)
except (FileNotFoundError, json.JSONDecodeError):
    data = {}

data["name"] = "nteract"
data.setdefault("owner", {"name": "nteract"})
plugins = data.setdefault("plugins", [])

entry = {
    "name": plugin_name,
    "source": source,
    "description": description,
    "version": plugin_version,
}

# Upsert by name; preserve order (stable before nightly by convention).
for i, p in enumerate(plugins):
    if p.get("name") == plugin_name:
        plugins[i] = entry
        break
else:
    plugins.append(entry)
    # Sort canonical order: nteract first, nightly second, anything else after.
    order = {"nteract": 0, "nightly": 1}
    plugins.sort(key=lambda p: (order.get(p.get("name"), 99), p.get("name", "")))

os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PY

codex_marketplace_json="$out_dir/.agents/plugins/marketplace.json"
mkdir -p "$out_dir/.agents/plugins"

python3 - "$codex_marketplace_json" "$plugin_name" "./plugins/$plugin_name" "$plugin_version" <<'PY'
import json
import os
import sys

path, plugin_name, source_path, plugin_version = sys.argv[1:5]

try:
    with open(path) as f:
        data = json.load(f)
except (FileNotFoundError, json.JSONDecodeError):
    data = {}

data["name"] = "nteract-plugins"
interface = data.setdefault("interface", {})
interface.setdefault("displayName", "nteract")
plugins = data.setdefault("plugins", [])

entry = {
    "name": plugin_name,
    "version": plugin_version,
    "source": {
        "source": "local",
        "path": source_path,
    },
    "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL",
    },
    "category": "Coding",
}

# Upsert by name; preserve order (stable before nightly by convention).
for i, p in enumerate(plugins):
    if p.get("name") == plugin_name:
        plugins[i] = entry
        break
else:
    plugins.append(entry)
    order = {"nteract": 0, "nightly": 1}
    plugins.sort(key=lambda p: (order.get(p.get("name"), 99), p.get("name", "")))

os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PY

# Generate README only if it doesn't exist or is the initial seed. The
# distribution repo's README is stable content; we don't churn it on
# every release.
readme="$out_dir/README.md"
if [[ ! -f "$readme" ]] || grep -Eq "auto-generated by the \[nteract/(desktop|nteract)\]" "$readme" 2>/dev/null; then
  cat > "$readme" <<'MARKDOWN'
# nteract plugins

This repository is auto-generated by the [nteract/nteract](https://github.com/nteract/nteract) release pipeline. **Do not open pull requests here** — edits are overwritten on release.

## Install in Codex

Register the marketplace (one-time):

```
codex plugin marketplace add nteract/agent-plugins
```

Then in a Codex session run `/plugin`, pick the **nteract** marketplace, and enable `nteract` (stable) or `nightly`. Codex resolves the per-platform `nteract-mcp` sidecar from the plugin's `bin/` automatically — no separate runtime install is required.

Manage the marketplace from the CLI:

```
codex plugin marketplace upgrade nteract-plugins   # refresh to latest tag
codex plugin marketplace remove  nteract-plugins   # uninstall
```

## Install in Claude Code

```
/plugin marketplace add nteract/agent-plugins
/plugin install nteract@nteract       # stable
/plugin install nightly@nteract       # nightly (for early adopters and devs)
```

## Pin to a specific version

Claude Code pins at install time:

```
/plugin install nteract@nteract --ref v2.3.0
/plugin install nightly@nteract --ref v2.3.1-nightly.202604221930
```

Codex pins at marketplace registration:

```
codex plugin marketplace add nteract/agent-plugins --ref v2.3.0
```

Stable tags follow `vX.Y.Z`. Nightly tags follow `vX.Y.Z-nightly.YYYYMMDDHHMM`.

## What's here

- `plugins/nteract/` — stable channel. Tracks `runt` / `runtimed` stable binaries.
- `plugins/nightly/` — nightly channel. Tracks `runt-nightly` / `runtimed-nightly`.
- Each plugin ships per-platform `nteract-mcp` binaries and a small shell/cmd dispatch wrapper in its `bin/`.

Source: <https://github.com/nteract/nteract/tree/main/plugins>
MARKDOWN
fi

echo "assembled ${channel} slice (${plugin_name}) under $out_dir"
