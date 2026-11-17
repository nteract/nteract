import json
import unittest

from scoped_channel_fixture import checkpoint, classify, notebook, response


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


if __name__ == "__main__":
    unittest.main()
