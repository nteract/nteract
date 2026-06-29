#!/usr/bin/env python3
"""Validate changed documentation and agent-guidance files.

This checker is intentionally changed-file scoped. The repository still has
some historical Markdown outside the active docs tree; this job should prevent
new stale references without turning unrelated baseline cleanup into a
precondition for every docs PR.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import urllib.parse
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
DOCS_SUBDIRS_REQUIRING_INDEX = {
    "adr",
    "audits",
    "measurements",
    "memos",
    "plans",
    "prd",
    "runbooks",
}
GUIDANCE_EXTENSIONS = {".md", ".mdx"}

REFERENCE_LINK_RE = re.compile(r"^\s*\[(?!\^)[^\]\n]+\]:\s*(.+?)\s*$", re.MULTILINE)


def tracked_files() -> set[str]:
    output = subprocess.check_output(["git", "ls-files"], cwd=REPO_ROOT, text=True)
    return set(output.splitlines())


def is_guidance_path(path: Path) -> bool:
    rel = path.as_posix()
    return (
        rel == "AGENTS.md"
        or rel.endswith("/AGENTS.md")
        or rel == "CLAUDE.md"
        or rel.endswith("/CLAUDE.md")
        or rel in {"README.md", "CONTRIBUTING.md", "DESIGN.md", "RELEASING.md"}
        or rel == "scripts/ci/check-docs-guidance.py"
        or rel.startswith("docs/")
        or rel.startswith(".agents/")
        or rel.startswith(".claude/")
    )


def markdown_destination(raw_target: str) -> str:
    target = raw_target.strip()
    if target.startswith("<"):
        end = target.find(">")
        if end != -1:
            return target[1:end]
    return target.split(maxsplit=1)[0] if target else ""


def local_target(raw_target: str, source: Path) -> Path | None:
    target = markdown_destination(raw_target)
    if not target or target.startswith("#"):
        return None
    if re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*:", target):
        return None
    if target.startswith("//"):
        return None
    if target.startswith("<") and target.endswith(">"):
        target = target[1:-1]
    target = target.split("#", 1)[0].split("?", 1)[0]
    if not target:
        return None

    target = urllib.parse.unquote(target)
    if target.startswith("/"):
        candidate = REPO_ROOT / target.lstrip("/")
    else:
        candidate = REPO_ROOT / source.parent / target
    try:
        return candidate.resolve().relative_to(REPO_ROOT)
    except ValueError:
        return None


def iter_link_targets(text: str) -> list[tuple[int, str]]:
    targets: list[tuple[int, str]] = []
    cursor = 0
    while cursor < len(text):
        start = text.find("[", cursor)
        if start == -1:
            break
        if start > 0 and text[start - 1] == "!":
            cursor = start + 1
            continue
        label_end = text.find("]", start + 1)
        if label_end == -1 or label_end + 1 >= len(text) or text[label_end + 1] != "(":
            cursor = start + 1
            continue

        depth = 0
        target_start = label_end + 2
        index = target_start
        while index < len(text):
            char = text[index]
            if char == "\n":
                break
            if char == "\\":
                index += 2
                continue
            if char == "(":
                depth += 1
            elif char == ")":
                if depth == 0:
                    line = text.count("\n", 0, start) + 1
                    targets.append((line, text[target_start:index]))
                    break
                depth -= 1
            index += 1
        cursor = index + 1

    for match in REFERENCE_LINK_RE.finditer(text):
        line = text.count("\n", 0, match.start()) + 1
        targets.append((line, match.group(1)))
    return targets


def check_index(path: Path, errors: list[str]) -> None:
    parts = path.parts
    if len(parts) < 3 or parts[0] != "docs":
        return
    subdir = parts[1]
    if subdir not in DOCS_SUBDIRS_REQUIRING_INDEX:
        return
    index = REPO_ROOT / "docs" / subdir / "README.md"
    if not index.exists():
        errors.append(f"{path}: docs/{subdir}/ contains durable docs but has no README.md index")


def check_file(path: Path, tracked: set[str], errors: list[str]) -> None:
    absolute = REPO_ROOT / path
    check_index(path, errors)
    if path.suffix.lower() not in GUIDANCE_EXTENSIONS:
        return
    if not absolute.exists() or not absolute.is_file():
        return

    text = absolute.read_text(encoding="utf-8", errors="replace")
    for line, raw_target in iter_link_targets(text):
        target = local_target(raw_target, path)
        if target is None:
            continue
        target_path = REPO_ROOT / target
        target_str = target.as_posix()
        if target_path.exists() or target_str in tracked:
            continue
        errors.append(f"{path}:{line}: broken local link to {raw_target!r}")


def check_deleted_targets(paths: set[Path], tracked: set[str], errors: list[str]) -> None:
    deleted_targets = {path for path in paths if not (REPO_ROOT / path).exists()}
    if not deleted_targets:
        return

    for source_raw in sorted(tracked):
        source = Path(source_raw)
        absolute = REPO_ROOT / source
        if (
            source in deleted_targets
            or source.suffix.lower() not in GUIDANCE_EXTENSIONS
            or not is_guidance_path(source)
            or not absolute.exists()
        ):
            continue

        text = absolute.read_text(encoding="utf-8", errors="replace")
        for line, raw_target in iter_link_targets(text):
            target = local_target(raw_target, source)
            if target in deleted_targets:
                target_str = target.as_posix()
                errors.append(
                    f"{source}:{line}: link still points at deleted changed path {target_str!r}"
                )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--paths-json",
        help="JSON array of changed paths, as emitted by dorny/paths-filter.",
    )
    parser.add_argument("paths", nargs="*", help="Changed paths to validate")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    tracked = tracked_files()
    raw_paths = list(args.paths)
    if args.paths_json:
        try:
            decoded = json.loads(args.paths_json)
        except json.JSONDecodeError as error:
            print(f"::error::invalid --paths-json: {error}")
            return 1
        if not isinstance(decoded, list) or not all(isinstance(item, str) for item in decoded):
            print("::error::--paths-json must be a JSON array of strings")
            return 1
        raw_paths.extend(decoded)

    paths = []
    for raw in raw_paths:
        path = Path(raw)
        if path.is_absolute():
            try:
                path = path.resolve().relative_to(REPO_ROOT)
            except ValueError:
                continue
        if not is_guidance_path(path):
            continue
        paths.append(path)

    errors: list[str] = []
    unique_paths = set(paths)
    for path in sorted(unique_paths):
        check_file(path, tracked, errors)
    check_deleted_targets(unique_paths, tracked, errors)

    if errors:
        for error in errors:
            print(f"::error::{error}")
        return 1

    print(f"Checked {len(set(paths))} docs/agent guidance path(s).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
