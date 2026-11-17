import argparse
import hashlib
import importlib.util
import io
import json
import struct
import tarfile
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "preview_candidate", ROOT / "scripts/ci/package-preview-candidate.py"
)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
UI_SPEC = importlib.util.spec_from_file_location(
    "notebook_ui", ROOT / "scripts/package-notebook-ui.py"
)
UI = importlib.util.module_from_spec(UI_SPEC)
UI_SPEC.loader.exec_module(UI)
SHA = "a" * 40
BUILD = f"0.0.0-pr.5116.sha.{SHA}.run.123.attempt.1"


def archive(path, files):
    with tarfile.open(path, "w:gz") as tar:
        for name, data in files.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))


def macho(kind, cpu=0x0100000C):
    return struct.pack("<IIIIIIII", 0xFEEDFACF, cpu, 0, kind, 0, 0, 0, 0) + b"fixture"


class PreviewCandidateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.args = argparse.Namespace(
            commit=SHA,
            build_id=BUILD,
            run_url="https://github.com/nteract/nteract/actions/runs/123",
            daemon=root / "daemon",
            ui=root / "ui.tar.gz",
            wrapper=root / "wrapper.tgz",
            native=root / "native.tgz",
            output=root / "candidate",
        )
        self.args.daemon.write_bytes(macho(2))
        self.args.daemon.chmod(0o755)
        wrapper_manifest = {"name": "@runtimed/node", "version": "0.8.1"}
        self.wrapper = {"package/package.json": json.dumps(wrapper_manifest).encode()}
        for name in [
            "index.cjs",
            "index.d.ts",
            "binding.cjs",
            "binding.d.ts",
            "relay.cjs",
            "relay.d.ts",
        ]:
            self.wrapper["package/src/" + name] = b"fixture"
        archive(self.args.wrapper, self.wrapper)
        self.native_manifest = {
            "name": "@runtimed/node-darwin-arm64",
            "version": "0.8.1",
            "os": ["darwin"],
            "cpu": ["arm64"],
        }
        self.native = {
            "package/package.json": json.dumps(self.native_manifest).encode(),
            "package/" + MODULE.NATIVE: macho(6),
        }
        archive(self.args.native, self.native)
        dist = root / "dist"
        dist.mkdir()
        for name in ["index.html", "output-frame.html"]:
            (dist / name).write_text("fixture")
        attribution = root / "attribution"
        attribution.mkdir()
        for name in ["LICENSE.nteract", "THIRD_PARTY_NOTICES.txt"]:
            (attribution / name).write_text("fixture attribution")
        sbom = {
            "bomFormat": "CycloneDX",
            "specVersion": "1.6",
            "version": 1,
            "components": [{"name": "fixture", "type": "library"}],
            "metadata": {
                "component": {"type": "application", "name": "notebook-ui", "version": BUILD},
                "properties": [
                    {"name": "nteract:source-commit", "value": SHA},
                    {"name": "nteract:target", "value": "wasm32-unknown-unknown"},
                ],
            },
        }
        (attribution / "sbom.cdx.json").write_text(json.dumps(sbom))
        options = argparse.Namespace(
            dist=dist,
            attribution=attribution,
            output=self.args.ui,
            commit=SHA,
            version=BUILD,
            channel="nightly",
            source_date_epoch=0,
        )
        UI.validate_args(options)
        UI.create_archive(options)

    def test_normal_ui_packager_and_matching_outputs_form_candidate(self):
        manifest = MODULE.package_candidate(self.args)
        self.assertEqual(manifest["notebookUi"]["commit"], SHA)
        self.assertEqual(manifest["notebookUi"]["version"], manifest["buildId"])
        self.assertEqual(manifest["target"], "aarch64-apple-darwin")
        for name, record in manifest["artifacts"].items():
            data = (self.args.output / name).read_bytes()
            expected = {"size": len(data), "sha256": hashlib.sha256(data).hexdigest()}
            self.assertEqual(record, expected)
        self.assertIn("Not a signature or runtime authorization", manifest["trust"])
        self.assertTrue((self.args.output / "runtimed").stat().st_mode & 0o111)
        with self.assertRaises(FileExistsError):
            MODULE.package_candidate(self.args)

    def test_source_and_build_id_must_agree(self):
        self.args.commit = "b" * 40
        with self.assertRaisesRegex(ValueError, "Build ID"):
            MODULE.package_candidate(self.args)

    def test_ui_cannot_be_relabelled_to_another_source(self):
        self.args.commit = "b" * 40
        self.args.build_id = BUILD.replace(SHA, self.args.commit)
        with self.assertRaisesRegex(ValueError, "UI manifest"):
            MODULE.package_candidate(self.args)

    def test_run_identity_must_agree(self):
        self.args.run_url = self.args.run_url.replace("123", "124")
        with self.assertRaisesRegex(ValueError, "Run URL"):
            MODULE.package_candidate(self.args)

    def test_wrong_architecture_and_nonexecutable_daemon_rejected(self):
        self.args.daemon.write_bytes(macho(2, 0x01000007))
        with self.assertRaisesRegex(ValueError, "ARM64"):
            MODULE.package_candidate(self.args)
        self.args.daemon.write_bytes(macho(2))
        self.args.daemon.chmod(0o644)
        with self.assertRaisesRegex(ValueError, "executable"):
            MODULE.package_candidate(self.args)

    def test_mismatched_node_packages_rejected(self):
        self.native_manifest["version"] = "0.8.2"
        self.native["package/package.json"] = json.dumps(self.native_manifest).encode()
        archive(self.args.native, self.native)
        with self.assertRaisesRegex(ValueError, "Node wrapper/native"):
            MODULE.package_candidate(self.args)

    def test_missing_node_loader_rejected(self):
        del self.wrapper["package/src/binding.cjs"]
        archive(self.args.wrapper, self.wrapper)
        with self.assertRaisesRegex(ValueError, "Missing Node wrapper"):
            MODULE.package_candidate(self.args)

    def test_native_architecture_rejected_even_with_matching_package_label(self):
        self.native["package/" + MODULE.NATIVE] = macho(6, 0x01000007)
        archive(self.args.native, self.native)
        with self.assertRaisesRegex(ValueError, "ARM64"):
            MODULE.package_candidate(self.args)

    def test_wrong_ui_attribution_source_rejected(self):
        files = MODULE.archive_files(self.args.ui)
        sbom = json.loads(files["nteract-notebook-ui/sbom.cdx.json"])
        sbom["metadata"]["properties"][0]["value"] = "b" * 40
        files["nteract-notebook-ui/sbom.cdx.json"] = json.dumps(sbom).encode()
        archive(self.args.ui, files)
        with self.assertRaisesRegex(ValueError, "attribution"):
            MODULE.package_candidate(self.args)

    def test_path_escape_and_symlink_rejected_without_extraction(self):
        archive(self.args.wrapper, {"../escape": b"no"})
        with self.assertRaisesRegex(ValueError, "Unsafe"):
            MODULE.package_candidate(self.args)
        with tarfile.open(self.args.wrapper, "w:gz") as tar:
            link = tarfile.TarInfo("package/link")
            link.type = tarfile.SYMTYPE
            link.linkname = "/etc/passwd"
            tar.addfile(link)
        with self.assertRaisesRegex(ValueError, "Non-regular"):
            MODULE.package_candidate(self.args)
        self.assertFalse(self.args.output.exists())

    def test_normalized_archive_alias_cannot_replace_validated_material(self):
        for alias in ["package/./package.json", "package//package.json"]:
            archive(self.args.wrapper, {**self.wrapper, alias: b'{"name":"other"}'})
            with self.assertRaisesRegex(ValueError, "Noncanonical"):
                MODULE.package_candidate(self.args)
        self.assertFalse(self.args.output.exists())

    def test_daemon_symlink_rejected(self):
        path = self.args.daemon
        target = path.with_suffix(".real")
        path.rename(target)
        path.symlink_to(target)
        with self.assertRaisesRegex(ValueError, "regular file"):
            MODULE.package_candidate(self.args)


if __name__ == "__main__":
    unittest.main()
