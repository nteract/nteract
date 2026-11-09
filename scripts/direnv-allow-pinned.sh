#!/bin/bash
# Allow a checkout's .envrc in direnv only while it matches main.
#
# direnv keys an allow on the .envrc path plus its content, so every new
# worktree starts blocked. This grants the allow when the working .envrc is
# byte-identical to the one at this branch's merge-base with origin/main:
# content that main has already carried. A checkout that changes .envrc (a
# contributor's PR, a local edit) fails the comparison and stays blocked
# until a person reads it and runs `direnv allow`.
#
# The pin covers .envrc only. Anything .envrc reads from the checkout
# (a sourced file, a directory added to PATH) is outside it, so .envrc must
# stay self-contained for this to be safe to run unattended.
#
# Usage:
#   scripts/direnv-allow-pinned.sh [dir]    dir defaults to the current directory
#   scripts/direnv-allow-pinned.sh --hook   Claude Code hook: reads `cwd` from
#                                           the hook JSON on stdin
#
# Always exits 0 and writes nothing to stdout, so a hook neither blocks the
# session nor adds to its context. DIRENV_ALLOW_PINNED_VERBOSE=1 reports the
# decision on stderr.

set -u

TRUSTED_REF="refs/remotes/origin/main"

say() {
  if [ -n "${DIRENV_ALLOW_PINNED_VERBOSE:-}" ]; then
    printf 'direnv-allow-pinned: %s\n' "$*" >&2
  fi
}

dir="."
if [ "${1:-}" = "--hook" ]; then
  if ! command -v jq >/dev/null 2>&1; then
    say "jq not found; cannot read the hook input"
    exit 0
  fi
  dir="$(jq -r '.cwd // empty' 2>/dev/null)"
  if [ -z "$dir" ]; then
    say "hook input has no cwd"
    exit 0
  fi
elif [ -n "${1:-}" ]; then
  dir="$1"
fi

if ! command -v direnv >/dev/null 2>&1 || ! command -v git >/dev/null 2>&1; then
  say "direnv or git not found"
  exit 0
fi

root="$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null)" || {
  say "$dir is not in a git checkout"
  exit 0
}

if [ ! -f "$root/.envrc" ]; then
  say "no .envrc in $root"
  exit 0
fi

base="$(git -C "$root" merge-base HEAD "$TRUSTED_REF" 2>/dev/null)" || {
  say "no merge-base with $TRUSTED_REF"
  exit 0
}

trusted="$(git -C "$root" rev-parse --verify --quiet "$base:.envrc")" || {
  say "main has no .envrc at $base"
  exit 0
}

# --no-filters hashes the bytes direnv will read. A checkout's .gitattributes
# cannot make different content hash the same through line-ending conversion.
actual="$(git -C "$root" hash-object --no-filters -- "$root/.envrc" 2>/dev/null)" || {
  say "cannot hash $root/.envrc"
  exit 0
}

if [ "$actual" != "$trusted" ]; then
  say "$root/.envrc differs from main at ${base:0:12}; leaving direnv as it is"
  exit 0
fi

if direnv allow "$root/.envrc" >/dev/null 2>&1; then
  say "allowed $root/.envrc (matches main at ${base:0:12})"
else
  say "direnv allow failed for $root/.envrc"
fi
exit 0
