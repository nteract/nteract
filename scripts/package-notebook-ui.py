#!/usr/bin/env python3
"""Package the production notebook frontend for release embedders."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
import re
import sys
import tarfile
from pathlib import Path

BUNDLE_ROOT = "nteract-notebook-ui"
REQUIRED_FILES = ("index.html", "output-frame.html")
RESERVED_FILES = ("LICENSE.nteract", "nteract-notebook-ui.json")
TOKEN_PATTERN = re.compile(r"^[A-Za-z0-9._-]+$")
COMMIT_PATTERN = re.compile(r"^[0-9a-f]{40}$")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dist", type=Path, required=True)
    parser.add_argument("--license", dest="license_path", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--channel", choices=("stable", "nightly"), required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--source-date-epoch", type=int, required=True)
    return parser.parse_args()


def validate_args(args: argparse.Namespace) -> None:
    if not args.dist.is_dir():
        raise ValueError(f"notebook UI directory does not exist: {args.dist}")
    if not args.license_path.is_file():
        raise ValueError(f"license file does not exist: {args.license_path}")
    if not TOKEN_PATTERN.fullmatch(args.version):
        raise ValueError("version may contain only letters, digits, dots, underscores, and hyphens")
    if not COMMIT_PATTERN.fullmatch(args.commit):
        raise ValueError("commit must be a lowercase 40-character Git SHA")
    if args.source_date_epoch < 0:
        raise ValueError("source-date-epoch must be non-negative")

    for relative_path in REQUIRED_FILES:
        if not (args.dist / relative_path).is_file():
            raise ValueError(f"notebook UI is missing required file: {relative_path}")
    for relative_path in RESERVED_FILES:
        if (args.dist / relative_path).exists():
            raise ValueError(f"notebook UI contains reserved bundle file: {relative_path}")


def tar_info(name: str, *, size: int, mode: int, mtime: int, kind: bytes) -> tarfile.TarInfo:
    info = tarfile.TarInfo(name)
    info.size = size
    info.mode = mode
    info.mtime = mtime
    info.uid = 0
    info.gid = 0
    info.uname = ""
    info.gname = ""
    info.type = kind
    return info


def add_bytes(archive: tarfile.TarFile, name: str, contents: bytes, mtime: int) -> None:
    info = tar_info(name, size=len(contents), mode=0o644, mtime=mtime, kind=tarfile.REGTYPE)
    archive.addfile(info, io.BytesIO(contents))


def add_directory(archive: tarfile.TarFile, name: str, mtime: int) -> None:
    info = tar_info(name.rstrip("/") + "/", size=0, mode=0o755, mtime=mtime, kind=tarfile.DIRTYPE)
    archive.addfile(info)


def iter_dist_entries(dist: Path) -> list[Path]:
    entries = sorted(dist.rglob("*"), key=lambda path: path.relative_to(dist).as_posix())
    for entry in entries:
        if entry.is_symlink():
            raise ValueError(f"notebook UI contains unsupported symlink: {entry.relative_to(dist)}")
        if not entry.is_dir() and not entry.is_file():
            raise ValueError(f"notebook UI contains unsupported entry: {entry.relative_to(dist)}")
    return entries


def create_archive(args: argparse.Namespace) -> str:
    args.output.parent.mkdir(parents=True, exist_ok=True)
    manifest = {
        "channel": args.channel,
        "commit": args.commit,
        "entrypoint": "index.html",
        "outputDocument": "output-frame.html",
        "schemaVersion": 1,
        "version": args.version,
    }
    manifest_bytes = (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode()
    license_bytes = args.license_path.read_bytes()

    with (
        args.output.open("wb") as raw_output,
        gzip.GzipFile(
            fileobj=raw_output, mode="wb", filename="", mtime=args.source_date_epoch
        ) as compressed,
        tarfile.open(fileobj=compressed, mode="w", format=tarfile.GNU_FORMAT) as archive,
    ):
        add_directory(archive, BUNDLE_ROOT, args.source_date_epoch)
        entries: list[tuple[str, Path | bytes]] = [
            (entry.relative_to(args.dist).as_posix(), entry)
            for entry in iter_dist_entries(args.dist)
        ]
        entries.extend(
            [
                ("LICENSE.nteract", license_bytes),
                ("nteract-notebook-ui.json", manifest_bytes),
            ]
        )
        for relative, entry in sorted(entries, key=lambda item: item[0]):
            archive_name = f"{BUNDLE_ROOT}/{relative}"
            if isinstance(entry, bytes):
                add_bytes(archive, archive_name, entry, args.source_date_epoch)
            elif entry.is_dir():
                add_directory(archive, archive_name, args.source_date_epoch)
            else:
                add_bytes(archive, archive_name, entry.read_bytes(), args.source_date_epoch)

    digest = hashlib.sha256(args.output.read_bytes()).hexdigest()
    checksum_path = args.output.with_name(args.output.name + ".sha256")
    checksum_path.write_text(f"{digest}  {args.output.name}\n", encoding="utf-8")
    return digest


def main() -> int:
    args = parse_args()
    try:
        validate_args(args)
        digest = create_archive(args)
    except (OSError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1

    print(f"Created {args.output} (sha256: {digest})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
