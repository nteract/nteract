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

    def check(self, mode: str = "--check") -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["bash", str(CHECK), TAG, self.source, mode],
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

    def test_reservation_pins_source_and_survives_main_advancing(self) -> None:
        result = self.check("--reserve")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            self.git("ls-remote", "origin", f"refs/tags/{TAG}"),
            f"{self.source}\trefs/tags/{TAG}",
        )
        before = self.git("ls-remote", "origin")
        for mode in ["--reserve", "--require"]:
            self.assertEqual(self.check(mode).returncode, 0)
            self.assertEqual(self.git("ls-remote", "origin"), before)
        self.assertEqual(self.git("rev-parse", "HEAD"), self.later)

    def test_publication_requires_existing_tag(self) -> None:
        result = self.check("--require")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("missing", result.stderr)
        self.assertEqual(self.git("ls-remote", "origin", f"refs/tags/{TAG}"), "")

    def test_reservation_never_overwrites_conflicting_tag(self) -> None:
        for annotated in [False, True]:
            with self.subTest(annotated=annotated):
                self.publish_tag(self.later, annotated)
                before = self.git("ls-remote", "origin")
                for mode in ["--reserve", "--require"]:
                    self.assertNotEqual(self.check(mode).returncode, 0)
                    self.assertEqual(self.git("ls-remote", "origin"), before)
                self.git("push", "origin", f":refs/tags/{TAG}")
                self.git("tag", "-d", TAG)

    def test_denied_reservation_does_not_report_success(self) -> None:
        hook = self.remote / "hooks" / "pre-receive"
        hook.write_text("#!/bin/sh\nexit 1\n")
        hook.chmod(0o755)
        result = self.check("--reserve")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.git("ls-remote", "origin", f"refs/tags/{TAG}"), "")

    def test_unknown_mode_fails_without_mutating_remote(self) -> None:
        before = self.git("ls-remote", "origin")
        self.assertNotEqual(self.check("--force").returncode, 0)
        self.assertEqual(self.git("ls-remote", "origin"), before)

    def test_changelog_filters_unpublished_tags_only_in_local_checkout(self) -> None:
        self.publish_tag(self.source, False)
        published_tag = "v2.7.5-stable.202609240900"
        abandoned_tag = "v2.7.6-stable.202609250900"
        for tag in [published_tag, abandoned_tag, "other-project-tag"]:
            self.git("tag", tag, self.source)
            self.git("push", "origin", f"refs/tags/{tag}")
        before = self.git("ls-remote", "origin")
        published = self.repo / "published-tags"
        published.write_text(published_tag + "\n")
        result = subprocess.run(
            ["bash", str(CHECK.with_name("filter-unpublished-release-tags.sh")), str(published)],
            cwd=self.repo,
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.git("tag", "-l").splitlines(), ["other-project-tag", published_tag])
        self.assertEqual(self.git("ls-remote", "origin"), before)
        self.assertEqual(self.check("--require").returncode, 0)

    def test_unreadable_remote_fails_instead_of_treating_tag_as_absent(self) -> None:
        self.git("remote", "set-url", "origin", str(self.remote / "missing"))
        self.assertNotEqual(self.check().returncode, 0)


if __name__ == "__main__":
    unittest.main()
