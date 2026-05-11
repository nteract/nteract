import subprocess
from pathlib import Path

from pr_reviewer.git import PullRequestInfo
from pr_reviewer.workspace import prepare_review_workspace


def test_prepare_review_workspace_builds_isolated_worktree(tmp_path: Path) -> None:
    calls: list[tuple[list[str], Path | None]] = []
    repo = tmp_path / "repo"
    repo.mkdir()
    workspace = tmp_path / "review"

    def runner(args: list[str], *, cwd: Path | None = None, check: bool = True):
        calls.append((args, cwd))
        if args[:2] == ["git", "merge-base"]:
            stdout = "mergebase\n"
        elif args[:4] == ["git", "diff", "--find-renames", "--name-only"]:
            stdout = "src/a.py\nsrc/b.py\n"
        elif args[:4] == ["git", "diff", "--find-renames", "--stat"]:
            stdout = " src/a.py | 2 ++\n"
        else:
            stdout = ""
        return subprocess.CompletedProcess(args, 0, stdout=stdout, stderr="")

    pr = PullRequestInfo(
        number=12,
        url="https://github.com/nteract/desktop/pull/12",
        title="Patch",
        base_ref="main",
        head_ref="feature",
        head_sha="head",
        base_sha="base",
    )

    result = prepare_review_workspace(repo, pr, workspace_dir=workspace, runner=runner)

    assert result.path == workspace
    assert result.reviewed_diff.merge_base == "mergebase"
    assert result.reviewed_diff.changed_files == ["src/a.py", "src/b.py"]
    assert (
        ["git", "worktree", "add", "--detach", str(workspace), "refs/remotes/origin/pr/12"],
        repo,
    ) in calls
