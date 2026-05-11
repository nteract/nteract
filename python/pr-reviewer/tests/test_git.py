import json
import subprocess
from pathlib import Path

from pr_reviewer.git import PullRequestRef, resolve_pr


def test_pull_request_ref_extracts_number_from_url() -> None:
    ref = PullRequestRef("https://github.com/nteract/desktop/pull/2508")

    assert ref.number == 2508


def test_pull_request_ref_extracts_number_from_numeric_selector() -> None:
    ref = PullRequestRef("2508")

    assert ref.number == 2508


def test_resolve_pr_uses_gh_json() -> None:
    calls: list[list[str]] = []

    def runner(args: list[str], *, cwd: Path | None = None, check: bool = True):
        calls.append(args)
        return subprocess.CompletedProcess(
            args,
            0,
            stdout=json.dumps(
                {
                    "number": 2508,
                    "url": "https://github.com/nteract/desktop/pull/2508",
                    "title": "Add reviewer",
                    "baseRefName": "main",
                    "headRefName": "feature",
                    "headRefOid": "abc123",
                    "baseRefOid": "def456",
                }
            ),
            stderr="",
        )

    pr = resolve_pr(PullRequestRef("2508", repo="nteract/desktop"), cwd=Path("."), runner=runner)

    assert calls[0][-2:] == ["--repo", "nteract/desktop"]
    assert pr.number == 2508
    assert pr.base_ref == "main"
    assert pr.head_sha == "abc123"
