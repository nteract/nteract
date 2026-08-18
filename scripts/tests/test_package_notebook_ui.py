from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
PACKAGER = REPO_ROOT / "scripts" / "package-notebook-ui.py"
COMMIT = "0123456789abcdef0123456789abcdef01234567"


class PackageNotebookUiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.dist = self.root / "dist"
        (self.dist / "assets").mkdir(parents=True)
        (self.dist / "index.html").write_text("<main>notebook</main>\n", encoding="utf-8")
        (self.dist / "output-frame.html").write_text("<main>output</main>\n", encoding="utf-8")
        (self.dist / "assets" / "main-example.js").write_text("export {};\n", encoding="utf-8")
        self.license_path = self.root / "LICENSE"
        self.license_path.write_text("BSD-3-Clause\n", encoding="utf-8")

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def run_packager(self, output: Path) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [
                sys.executable,
                str(PACKAGER),
                "--dist",
                str(self.dist),
                "--license",
                str(self.license_path),
                "--output",
                str(output),
                "--channel",
                "nightly",
                "--version",
                "2.7.0-nightly.202608180909",
                "--commit",
                COMMIT,
                "--source-date-epoch",
                "1776556800",
            ],
            capture_output=True,
            text=True,
        )

    def test_packages_expected_files_and_metadata_deterministically(self) -> None:
        first = self.root / "first.tar.gz"
        second = self.root / "second.tar.gz"

        first_result = self.run_packager(first)
        second_result = self.run_packager(second)
        self.assertEqual(first_result.returncode, 0, first_result.stderr)
        self.assertEqual(second_result.returncode, 0, second_result.stderr)
        self.assertEqual(
            hashlib.sha256(first.read_bytes()).digest(),
            hashlib.sha256(second.read_bytes()).digest(),
        )

        with tarfile.open(first, "r:gz") as archive:
            names = archive.getnames()
            self.assertEqual(names, sorted(names))
            self.assertIn("nteract-notebook-ui/index.html", names)
            self.assertIn("nteract-notebook-ui/output-frame.html", names)
            self.assertIn("nteract-notebook-ui/LICENSE.nteract", names)
            manifest_file = archive.extractfile("nteract-notebook-ui/nteract-notebook-ui.json")
            self.assertIsNotNone(manifest_file)
            manifest = json.loads(manifest_file.read())
            self.assertEqual(manifest["schemaVersion"], 1)
            self.assertEqual(manifest["channel"], "nightly")
            self.assertEqual(manifest["commit"], COMMIT)

        checksum = first.with_name(first.name + ".sha256").read_text(encoding="utf-8")
        self.assertEqual(
            checksum, f"{hashlib.sha256(first.read_bytes()).hexdigest()}  first.tar.gz\n"
        )

    def test_rejects_an_incomplete_frontend_build(self) -> None:
        (self.dist / "output-frame.html").unlink()
        result = self.run_packager(self.root / "incomplete.tar.gz")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("missing required file: output-frame.html", result.stderr)

    def test_rejects_a_reserved_bundle_file(self) -> None:
        (self.dist / "LICENSE.nteract").write_text("unexpected\n", encoding="utf-8")
        result = self.run_packager(self.root / "reserved.tar.gz")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("contains reserved bundle file: LICENSE.nteract", result.stderr)

    def test_rejects_a_symbolic_link(self) -> None:
        os.symlink(self.dist / "index.html", self.dist / "linked-index.html")
        result = self.run_packager(self.root / "symlink.tar.gz")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("contains unsupported symlink: linked-index.html", result.stderr)


if __name__ == "__main__":
    unittest.main()
