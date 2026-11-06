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
ATTRIBUTION_FILES = ("LICENSE.nteract", "THIRD_PARTY_NOTICES.txt", "sbom.cdx.json")


class PackageNotebookUiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.dist = self.root / "dist"
        (self.dist / "assets").mkdir(parents=True)
        (self.dist / "index.html").write_text("<main>notebook</main>\n", encoding="utf-8")
        (self.dist / "output-frame.html").write_text("<main>output</main>\n", encoding="utf-8")
        (self.dist / "assets" / "main-example.js").write_text("export {};\n", encoding="utf-8")
        self.attribution = self.root / "attribution"
        self.attribution.mkdir()
        (self.attribution / "LICENSE.nteract").write_text("BSD-3-Clause\n", encoding="utf-8")
        (self.attribution / "THIRD_PARTY_NOTICES.txt").write_text(
            "Example dependency\nCopyright Example\nMIT license text\n", encoding="utf-8"
        )
        (self.attribution / "sbom.cdx.json").write_text(
            json.dumps(
                {
                    "bomFormat": "CycloneDX",
                    "specVersion": "1.6",
                    "version": 1,
                    "metadata": {
                        "component": {
                            "type": "application",
                            "name": "notebook-ui",
                            "version": "2.7.0-nightly.202608180909",
                        },
                        "properties": [
                            {"name": "nteract:source-commit", "value": COMMIT},
                            {"name": "nteract:target", "value": "wasm32-unknown-unknown"},
                        ],
                    },
                    "components": [{"type": "library", "name": "example", "version": "1.0.0"}],
                }
            ),
            encoding="utf-8",
        )

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def run_packager(self, output: Path) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [
                sys.executable,
                str(PACKAGER),
                "--dist",
                str(self.dist),
                "--attribution",
                str(self.attribution),
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
            for name in ATTRIBUTION_FILES:
                with archive.extractfile(f"nteract-notebook-ui/{name}") as contents:
                    self.assertEqual(contents.read(), (self.attribution / name).read_bytes())
            manifest_file = archive.extractfile("nteract-notebook-ui/nteract-notebook-ui.json")
            self.assertIsNotNone(manifest_file)
            manifest = json.loads(manifest_file.read())
            self.assertEqual(manifest["schemaVersion"], 1)
            self.assertEqual(manifest["channel"], "nightly")
            self.assertEqual(manifest["commit"], COMMIT)
            self.assertEqual(manifest["license"], "LICENSE.nteract")
            self.assertEqual(manifest["notices"], "THIRD_PARTY_NOTICES.txt")
            self.assertEqual(manifest["sbom"], "sbom.cdx.json")

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
        for name in (*ATTRIBUTION_FILES, "nteract-notebook-ui.json"):
            with self.subTest(name=name):
                path = self.dist / name
                path.write_text("unexpected\n", encoding="utf-8")
                result = self.run_packager(self.root / "reserved.tar.gz")
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(f"contains reserved bundle file: {name}", result.stderr)
                path.unlink()

    def test_requires_each_attribution_file(self) -> None:
        for name in ATTRIBUTION_FILES:
            with self.subTest(name=name):
                path = self.attribution / name
                contents = path.read_bytes()
                path.unlink()
                output = self.root / "missing.tar.gz"
                result = self.run_packager(output)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(f"attribution requires a regular file: {name}", result.stderr)
                self.assertFalse(output.exists())
                path.write_bytes(contents)

    def test_rejects_empty_or_invalid_attribution_text(self) -> None:
        for name in ATTRIBUTION_FILES:
            path = self.attribution / name
            original = path.read_bytes()
            for contents in (b"", b" \n\t", b"\x00", b"\xff"):
                with self.subTest(name=name, contents=contents):
                    path.write_bytes(contents)
                    result = self.run_packager(self.root / "invalid.tar.gz")
                    self.assertNotEqual(result.returncode, 0)
            path.write_bytes(original)

    def test_rejects_invalid_sbom(self) -> None:
        path = self.attribution / "sbom.cdx.json"
        valid = json.loads(path.read_text(encoding="utf-8"))
        invalid = ["{", "null", "[]", "{}"]
        for key, value in (
            ("bomFormat", "SPDX"),
            ("specVersion", "bogus"),
            ("version", True),
            ("version", 0),
            ("components", []),
            ("components", {}),
            ("components", [None]),
            ("components", [{"name": "", "type": "library"}]),
        ):
            invalid.append(json.dumps({**valid, key: value}))
        for contents in invalid:
            with self.subTest(contents=contents):
                path.write_text(contents, encoding="utf-8")
                result = self.run_packager(self.root / "invalid.tar.gz")
                self.assertNotEqual(result.returncode, 0)

    def test_rejects_mismatched_sbom_identity(self) -> None:
        path = self.attribution / "sbom.cdx.json"
        original = path.read_text(encoding="utf-8")
        for field, value in (
            ("metadata", None),
            ("name", "runtimed"),
            ("version", "1.0.0"),
            ("nteract:source-commit", "f" * 40),
            ("nteract:target", "aarch64-apple-darwin"),
            ("properties", []),
            ("properties", [None]),
        ):
            with self.subTest(field=field, value=value):
                sbom = json.loads(original)
                if field == "metadata":
                    sbom[field] = value
                elif field == "properties":
                    sbom["metadata"][field] = value
                elif field.startswith("nteract:"):
                    for prop in sbom["metadata"]["properties"]:
                        if prop["name"] == field:
                            prop["value"] = value
                else:
                    sbom["metadata"]["component"][field] = value
                path.write_text(json.dumps(sbom), encoding="utf-8")
                output = self.root / "wrong-identity.tar.gz"
                result = self.run_packager(output)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("attribution SBOM", result.stderr)
                self.assertFalse(output.exists())

    def test_rejects_attribution_symlinks(self) -> None:
        path = self.attribution / "LICENSE.nteract"
        path.unlink()
        os.symlink(self.dist / "index.html", path)
        result = self.run_packager(self.root / "symlink.tar.gz")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("attribution requires a regular file: LICENSE.nteract", result.stderr)

    def test_rejects_missing_attribution_directory(self) -> None:
        self.attribution = self.root / "missing"
        result = self.run_packager(self.root / "missing.tar.gz")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("attribution directory does not exist", result.stderr)

    def test_rejects_a_symbolic_link(self) -> None:
        os.symlink(self.dist / "index.html", self.dist / "linked-index.html")
        result = self.run_packager(self.root / "symlink.tar.gz")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("contains unsupported symlink: linked-index.html", result.stderr)


if __name__ == "__main__":
    unittest.main()
