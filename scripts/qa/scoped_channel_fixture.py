#!/usr/bin/env python3
"""Disposable, observable CEP-42 fixture for manual native channel-review QA.

This server never grants consent or drives the UI. Local-only is the default;
--live explicitly redirects related-channel requests to public conda-forge.
"""

import argparse
import json
import re
import sys
import tempfile
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

SUBDIRS = {"noarch", "osx-arm64", "osx-64", "linux-64", "linux-aarch64", "win-64"}
METADATA = {
    "repodata.json",
    "repodata.json.zst",
    "repodata.json.bz2",
    "repodata_shards.msgpack.zst",
}


def classify(path: str) -> str:
    parts = urlsplit(path).path.strip("/").split("/")
    if (
        len(parts) not in {3, 4}
        or parts[0] not in {"declared", "related"}
        or parts[1] not in SUBDIRS
    ):
        return "invalid"
    filename = "/".join(parts[2:])
    if not re.fullmatch(r"[A-Za-z0-9_.+/-]+", filename) or ".." in filename:
        return "invalid"
    if (
        filename in METADATA
        or re.fullmatch(r"[0-9a-f]{64}\.msgpack\.zst", filename)
        or (filename.startswith("shards/") and filename.endswith(".msgpack.zst"))
    ):
        return "metadata"
    if filename.endswith((".conda", ".tar.bz2")) and filename not in {".conda", ".tar.bz2"}:
        return "package"
    return "invalid"


def checkpoint(rows: list[dict], stage: str) -> None:
    """Assert observable boundaries; checkpoints do not grant server authority."""
    if stage not in {"metadata", "install"}:
        raise ValueError("Unknown approval stage")
    if not any(row["path"].startswith("/declared/") and row["kind"] == "metadata" for row in rows):
        raise ValueError("No declared metadata observed: first reach the native metadata dialog")
    if any(row["kind"] == "package" for row in rows):
        raise ValueError("Package contact occurred before final approval")
    related = any(row["path"].startswith("/related/") for row in rows)
    if stage == "metadata" and related:
        raise ValueError("Related-channel contact occurred before metadata approval")
    inspected_related = any(
        row["path"].startswith("/related/") and row["kind"] == "metadata" for row in rows
    )
    if stage == "install" and not inspected_related:
        raise ValueError("No related metadata observed; check the native UI separately")


def notebook(channel: str) -> dict:
    return {
        "nbformat": 4,
        "nbformat_minor": 5,
        "metadata": {
            "kernelspec": {"name": "python3", "display_name": "Python 3", "language": "python"},
            "runt": {
                "schema_version": "1",
                "conda": {
                    "dependencies": ["rich"],
                    "channels": [channel],
                    "python": "3.13",
                },
            },
        },
        "cells": [
            {
                "id": "verify",
                "cell_type": "code",
                "source": (
                    "import rich, sys\nprint('reviewed native kernel executed')\n"
                    "print(sys.prefix)\nprint(1 + 1)"
                ),
                "metadata": {},
                "outputs": [],
                "execution_count": None,
            }
        ],
    }


def response(request_path: str, live: bool) -> tuple[int, dict[str, str], bytes]:
    if classify(request_path) == "invalid":
        return 404, {}, b""
    path = urlsplit(request_path).path
    if live and path.startswith("/related/"):
        return (
            302,
            {
                "Location": "https://conda.anaconda.org/conda-forge/"
                + path.removeprefix("/related/")
            },
            b"",
        )
    if not path.endswith("/repodata.json"):
        return 404, {}, b""
    info: dict = {"subdir": path.split("/")[-2]}
    if path.startswith("/declared/"):
        info["channel_relations"] = {"base": "../related"}
    body = json.dumps(
        {"info": info, "packages": {}, "packages.conda": {}, "repodata_version": 1}
    ).encode()
    return 200, {}, body


def serve(live: bool) -> None:
    # A short private root avoids macOS SUN_LEN. Never reuse/delete user caches.
    root = Path(tempfile.mkdtemp(prefix="ncr-", dir="/tmp" if sys.platform == "darwin" else None))
    ledger = root / "requests.jsonl"
    ledger.touch()
    lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            kind = classify(self.path)
            with lock, ledger.open("a") as output:
                output.write(
                    json.dumps(
                        {
                            "at": datetime.now(timezone.utc).isoformat(),
                            "path": self.path,
                            "kind": kind,
                        }
                    )
                    + "\n"
                )
            status, headers, body = response(self.path, live)
            self.send_response(status)
            for key, value in headers.items():
                self.send_header(key, value)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    channel = f"http://127.0.0.1:{server.server_port}/declared"
    (root / "review.ipynb").write_text(json.dumps(notebook(channel), indent=2))
    (root / "session.json").write_text(
        json.dumps(
            {
                "channel": channel,
                "live": live,
                "note": "Fresh fixture storage only; OS caches are not cold-reset.",
            },
            indent=2,
        )
    )
    print(
        json.dumps(
            {
                "root": str(root),
                "notebook": str(root / "review.ipynb"),
                "ledger": str(ledger),
                "live": live,
            }
        ),
        flush=True,
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        print(f"Stopped fixture; retained evidence at {root}", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    start = commands.add_parser("serve")
    start.add_argument(
        "--live", action="store_true", help="Explicitly allow public conda-forge redirects"
    )
    check = commands.add_parser("check")
    check.add_argument("ledger", type=Path)
    check.add_argument("--before", choices=("metadata", "install"), required=True)
    args = parser.parse_args()
    if args.command == "serve":
        serve(args.live)
    else:
        rows = [json.loads(line) for line in args.ledger.read_text().splitlines()]
        checkpoint(rows, args.before)
        print(f"PASS: {len(rows)} recorded requests before {args.before} approval")


if __name__ == "__main__":
    main()
