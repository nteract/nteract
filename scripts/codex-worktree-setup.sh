#!/bin/bash
# Bootstrap a Codex-created worktree after the repo has been checked out.
#
# The Codex UI writes .codex/environments/environment.toml per worktree; keep
# that generated file out of git and point its setup script at this helper.

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

if command -v direnv >/dev/null 2>&1; then
  direnv allow
else
  echo "direnv not found; skipping direnv allow" >&2
fi
