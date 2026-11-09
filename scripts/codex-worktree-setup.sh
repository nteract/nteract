#!/bin/bash
# Bootstrap a Codex-created worktree after the repo has been checked out.
#
# The Codex UI writes .codex/environments/environment.toml per worktree; keep
# that generated file out of git and point its setup script at this helper.
#
# Claude Code worktrees get the same direnv step from the SessionStart hook
# in .claude/settings.json. Both call scripts/direnv-allow-pinned.sh.

set -euo pipefail

if ! command -v git >/dev/null 2>&1; then
  echo "git is required for Codex worktree setup" >&2
  exit 1
fi

if [ -n "${CODEX_WORKTREE_PATH:-}" ]; then
  cd "$CODEX_WORKTREE_PATH"
else
  cd "$(git rev-parse --show-toplevel)"
fi

git lfs pull

# Allow .envrc in direnv only while it matches main. The script exits 0 in
# every case, so a blocked or missing direnv never fails worktree setup.
scripts/direnv-allow-pinned.sh
