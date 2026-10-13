#!/usr/bin/env bash
# Changelogs must not stop at a source tag reserved by a failed/current build.
# The caller supplies GitHub's successfully fetched, published release tags.
# Exclude the current tag too, so retries retain the original changelog.
# Remove tags only from this disposable checkout.
# Never push these local deletions to origin.
set -euo pipefail
published_tags="${1:?published release tag list required}"
current_tag="${2:?current release tag required}"
[[ -f "$published_tags" ]] || { echo "Missing published release tag list" >&2; exit 1; }
while IFS= read -r tag; do
  if [[ "$tag" == "$current_tag" ]] || ! grep -Fqx -- "$tag" "$published_tags"; then
    git tag -d "$tag"
  fi
done < <(git tag -l 'v*-nightly.*' 'v*-stable.*')
