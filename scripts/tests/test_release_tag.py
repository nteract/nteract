"""Exercise release-tag safety against a real local Git remote."""

from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path

CHECK = Path(__file__).resolve().parents[1] / "ci" / "check-release-tag.sh"
TAG = "v2.7.6-nightly.202609251717"


class ReleaseTagTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        root = Path(self.temporary.name)
        self.repo = root / "source"
        self.remote = root / "remote.git"
        self.repo.mkdir()
        self.git("init", "--bare", str(self.remote))
        self.git("init", "-b", "main")
        self.git("config", "user.name", "Release test")
        self.git("config", "user.email", "release-test@example.invalid")
        self.git("remote", "add", "origin", str(self.remote))
        self.git("commit", "--allow-empty", "-m", "Built source")
        self.source = self.git("rev-parse", "HEAD")
        self.git("push", "origin", "main")
        self.git("commit", "--allow-empty", "-m", "Main moved during build")
        self.later = self.git("rev-parse", "HEAD")
        self.git("push", "origin", "main")

    def git(self, *args: str) -> str:
        return subprocess.run(
            ["git", *args],
            cwd=self.repo,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()

    def check(self) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["bash", str(CHECK), TAG, self.source],
            cwd=self.repo,
            capture_output=True,
            text=True,
        )

    def publish_tag(self, commit: str, annotated: bool) -> None:
        args = ["-a", "-m", "Release"] if annotated else []
        self.git("tag", *args, TAG, commit)
        self.git("push", "origin", f"refs/tags/{TAG}")

    def test_absent_tag_allows_built_source_after_main_moves(self) -> None:
        result = self.check()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(self.source, result.stdout)
        self.assertEqual(self.git("ls-remote", "origin", f"refs/tags/{TAG}"), "")

    def test_existing_matching_lightweight_and_annotated_tags(self) -> None:
        for annotated in [False, True]:
            with self.subTest(annotated=annotated):
                self.publish_tag(self.source, annotated)
                before = self.git("ls-remote", "origin")
                result = self.check()
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(self.git("ls-remote", "origin"), before)
                self.git("push", "origin", f":refs/tags/{TAG}")
                self.git("tag", "-d", TAG)

    def test_conflicting_tags_fail_without_mutating_remote(self) -> None:
        for annotated in [False, True]:
            with self.subTest(annotated=annotated):
                self.publish_tag(self.later, annotated)
                before = self.git("ls-remote", "origin")
                result = self.check()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("Refusing to publish", result.stderr)
                self.assertEqual(self.git("ls-remote", "origin"), before)
                self.git("push", "origin", f":refs/tags/{TAG}")
                self.git("tag", "-d", TAG)

    def test_unreadable_remote_fails_instead_of_treating_tag_as_absent(self) -> None:
        self.git("remote", "set-url", "origin", str(self.remote / "missing"))
        self.assertNotEqual(self.check().returncode, 0)


if __name__ == "__main__":
    unittest.main()
