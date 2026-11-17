import hashlib
import io
import json
import tarfile
import tempfile
import unittest
from pathlib import Path

from scoped_channel_fixture import LocalMirror, checkpoint, classify, notebook, response


class FixtureTests(unittest.TestCase):
    def test_local_topology_is_deterministic_and_has_no_packages(self):
        status, headers, body = response("/declared/osx-arm64/repodata.json", False)
        data = json.loads(body)
        self.assertEqual(status, 200)
        self.assertEqual(headers, {})
        self.assertEqual(data["info"]["channel_relations"], {"base": "../related"})
        self.assertEqual(data["packages"], {})
        status, headers, body = response("/related/noarch/repodata.json", False)
        self.assertEqual(status, 200)
        self.assertNotIn("channel_relations", json.loads(body)["info"])
        self.assertEqual(headers, {})

    def test_live_redirect_is_explicit_and_fixed_destination(self):
        path = "/related/noarch/rich-1.0-0.conda"
        self.assertEqual(response(path, False)[0], 404)
        self.assertEqual(
            response(path, True)[:2],
            (302, {"Location": "https://conda.anaconda.org/conda-forge/noarch/rich-1.0-0.conda"}),
        )

    def test_invalid_paths_are_never_redirected(self):
        for path in (
            "/other/noarch/a.conda",
            "/related/../a.conda",
            "/related/noarch/../a.conda",
            "/related/noarch/a%2fb.conda",
            "/related/invalid/a.conda",
        ):
            self.assertEqual(response(path, True)[0], 404, path)

    def test_metadata_and_archive_requests_are_distinct(self):
        self.assertEqual(classify("/related/noarch/repodata.json.bz2"), "metadata")
        self.assertEqual(classify("/related/noarch/shards/abc.msgpack.zst"), "metadata")
        self.assertEqual(classify("/related/noarch/python-1-0.tar.bz2"), "package")

    def test_root_level_content_addressed_shard_is_metadata(self):
        path = "/related/osx-arm64/" + "a" * 64 + ".msgpack.zst"
        self.assertEqual(classify(path), "metadata")
        self.assertEqual(response(path, True)[0], 302)
        self.assertEqual(response(path, False)[0], 404)
        self.assertEqual(classify("/related/osx-arm64/not-a-hash.msgpack.zst"), "invalid")

    def test_empty_ledger_cannot_pass_a_gate(self):
        with self.assertRaises(ValueError):
            checkpoint([], "metadata")

    def test_unrelated_traffic_cannot_pass_a_gate(self):
        with self.assertRaises(ValueError):
            checkpoint([{"path": "/favicon.ico", "kind": "invalid"}], "metadata")
        with self.assertRaises(ValueError):
            checkpoint([], "unknown")

    def test_metadata_checkpoint_rejects_related_contact(self):
        declared = {"path": "/declared/noarch/repodata.json", "kind": "metadata"}
        related = {"path": "/related/noarch/repodata.json", "kind": "metadata"}
        checkpoint([declared], "metadata")
        with self.assertRaises(ValueError):
            checkpoint([declared, related], "metadata")
        checkpoint([declared, related], "install")

    def test_install_checkpoint_requires_metadata_and_rejects_packages(self):
        related = {"path": "/related/noarch/repodata.json", "kind": "metadata"}
        with self.assertRaises(ValueError):
            checkpoint([{"path": "/declared/noarch/repodata.json", "kind": "metadata"}], "install")
        with self.assertRaises(ValueError):
            checkpoint([related, {"path": "/related/noarch/a.conda", "kind": "package"}], "install")

    def test_invalid_related_request_is_not_metadata_evidence(self):
        rows = [
            {"path": "/declared/noarch/repodata.json", "kind": "metadata"},
            {"path": "/related/noarch/not-metadata", "kind": "invalid"},
        ]
        for stage in ("metadata", "install"):
            with self.assertRaises(ValueError):
                checkpoint(rows, stage)

    def test_notebook_is_disposable_and_has_no_preapproved_state(self):
        data = notebook("http://127.0.0.1:1234/declared")
        self.assertEqual(
            data["metadata"]["runt"]["conda"]["channels"], ["http://127.0.0.1:1234/declared"]
        )
        self.assertIsNone(data["cells"][0]["execution_count"])
        self.assertEqual(data["cells"][0]["outputs"], [])
        self.assertEqual(set(data["metadata"]["runt"]), {"schema_version", "conda"})


class MirrorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "noarch").mkdir()
        # Same harmless one-file package shape as kernel-env/rattler_upgrade.rs.
        # This is an install fixture, not a Python interpreter or kernel.
        payload = b"benign fixture\n"
        index = {
            "name": "qa-marker",
            "version": "1",
            "build": "0",
            "build_number": 0,
            "subdir": "noarch",
            "depends": [],
        }
        paths = {
            "paths_version": 1,
            "paths": [
                {
                    "_path": "share/qa-marker.txt",
                    "path_type": "hardlink",
                    "sha256": hashlib.sha256(payload).hexdigest(),
                    "size_in_bytes": len(payload),
                }
            ],
        }
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode="w:bz2") as archive:
            for name, body in (
                ("info/index.json", json.dumps(index).encode()),
                ("info/paths.json", json.dumps(paths).encode()),
                ("share/qa-marker.txt", payload),
            ):
                header = tarfile.TarInfo(name)
                header.size = len(body)
                header.mode = 0o644
                archive.addfile(header, io.BytesIO(body))
        body = buffer.getvalue()
        self.package = "noarch/qa-marker-1-0.tar.bz2"
        (self.root / self.package).write_bytes(body)
        index.update(sha256=hashlib.sha256(body).hexdigest(), size=len(body))
        self.data = {
            "info": {"subdir": "noarch"},
            "packages": {"qa-marker-1-0.tar.bz2": index},
            "packages.conda": {},
        }
        self.save()

    def save(self):
        (self.root / "noarch/repodata.json").write_text(json.dumps(self.data))
        files = {
            name: hashlib.sha256((self.root / name).read_bytes()).hexdigest()
            for name in (self.package, "noarch/repodata.json")
        }
        (self.root / "manifest.json").write_text(json.dumps({"files": files}))

    def test_local_snapshot_serves_verified_bytes_without_redirect(self):
        mirror = LocalMirror(self.root)
        self.assertEqual(
            mirror.response("/related/" + self.package),
            (200, {}, (self.root / self.package).read_bytes()),
        )
        self.assertEqual(mirror.response("/related/noarch/repodata.json.zst")[0], 404)
        self.assertEqual(mirror.response("/related/noarch/../manifest.json")[0], 404)

    def test_changed_archive_refuses_without_fallback(self):
        mirror = LocalMirror(self.root)
        (self.root / self.package).write_bytes(b"changed")
        self.assertEqual(mirror.response("/related/" + self.package)[0], 409)
        with self.assertRaises(ValueError):
            LocalMirror(self.root)

    def test_repodata_checksum_and_size_must_match_archives(self):
        self.data["packages"]["qa-marker-1-0.tar.bz2"]["sha256"] = "0" * 64
        self.save()
        with self.assertRaises(ValueError):
            LocalMirror(self.root)

    def test_external_origin_and_extra_relations_are_rejected(self):
        self.data["info"]["channel_relations"] = {"base": "https://example.invalid"}
        self.save()
        with self.assertRaises(ValueError):
            LocalMirror(self.root)
        del self.data["info"]["channel_relations"]
        self.data["packages"]["qa-marker-1-0.tar.bz2"]["url"] = "https://example.invalid"
        self.save()
        with self.assertRaises(ValueError):
            LocalMirror(self.root)

    def test_changed_metadata_and_missing_package_refuse(self):
        mirror = LocalMirror(self.root)
        (self.root / "noarch/repodata.json").write_text("{}")
        self.assertEqual(mirror.response("/related/noarch/repodata.json")[0], 409)
        (self.root / self.package).unlink()
        self.assertEqual(mirror.response("/related/" + self.package)[0], 409)

    def test_unsupported_repodata_representation_is_rejected(self):
        self.data["v3"] = {"packages": {"additional": {}}}
        self.save()
        with self.assertRaisesRegex(ValueError, "Unsupported repodata representation"):
            LocalMirror(self.root)

    def test_file_escape_is_rejected(self):
        with tempfile.TemporaryDirectory() as outside:
            target = Path(outside) / "archive"
            target.write_bytes((self.root / self.package).read_bytes())
            (self.root / self.package).unlink()
            (self.root / self.package).symlink_to(target)
            with self.assertRaisesRegex(ValueError, "escaped its root"):
                LocalMirror(self.root)


if __name__ == "__main__":
    unittest.main()
