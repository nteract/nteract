from pathlib import Path

from pr_reviewer.git import PullRequestInfo
from pr_reviewer.prompt import build_review_prompt
from pr_reviewer.schema import ReviewedDiff
from pr_reviewer.workspace import ReviewWorkspace


def test_build_review_prompt_includes_pr_context() -> None:
    workspace = ReviewWorkspace(
        path=Path("/tmp/review"),
        pr=PullRequestInfo(
            number=5,
            url="https://github.com/nteract/desktop/pull/5",
            title="Improve review",
            base_ref="main",
            head_ref="branch",
            head_sha="head",
            base_sha="base",
        ),
        base_ref="origin/main",
        head_ref="HEAD",
        reviewed_diff=ReviewedDiff(
            base_ref="origin/main",
            head_ref="HEAD",
            merge_base="abc",
            changed_files=["src/a.py"],
            diff_stat=" src/a.py | 1 +\n",
        ),
    )

    prompt = build_review_prompt(workspace, extra_prompt="Only high confidence findings.")

    assert "https://github.com/nteract/desktop/pull/5" in prompt
    assert "- src/a.py" in prompt
    assert "Only high confidence findings." in prompt
