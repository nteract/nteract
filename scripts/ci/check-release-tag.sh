#!/usr/bin/env bash
# An existing tag owns release identity; target_commitish cannot move it.
# Reserve that identity before builds, then require it at publication time.
set -euo pipefail

tag="${1:?release tag required}"
source_sha="${2:?built source SHA required}"
mode="${3:---check}"
case "$mode" in
  --check|--reserve|--require) ;;
  *) echo "Unknown release tag mode: $mode" >&2; exit 1 ;;
esac
git check-ref-format "refs/tags/$tag"
[[ "$source_sha" =~ ^[0-9a-f]{40}$ ]] || { echo "Invalid source SHA: $source_sha" >&2; exit 1; }
refs=$(git ls-remote origin "refs/tags/$tag" "refs/tags/$tag^{}")
if [[ -z "$refs" ]]; then
  case "$mode" in
    --check)
      echo "Release tag $tag is available for $source_sha"
      exit 0
      ;;
    --require)
      echo "Release tag $tag is missing. Refusing to publish without the reserved source ref." >&2
      exit 1
      ;;
    --reserve)
      # No force and no local tag: an existing different source must not
      # be overwritten. A denied push stops before any build or publication.
      git push origin "$source_sha:refs/tags/$tag"
      refs=$(git ls-remote origin "refs/tags/$tag" "refs/tags/$tag^{}")
      ;;
  esac
fi

# Annotated tags point at a tag object; compare the peeled commit when present.
commit=$(awk '$2 ~ /\^\{\}$/ {print $1}' <<< "$refs")
if [[ -z "$commit" ]]; then
  commit=$(awk '{print $1}' <<< "$refs")
fi
if [[ "$commit" != "$source_sha" ]]; then
  echo "Release tag $tag points to $commit, but artifacts were built from $source_sha. Refusing to publish; leave the existing tag unchanged." >&2
  exit 1
fi
echo "Release tag $tag matches built source $source_sha"
