import subprocess
from pathlib import Path

import pytest

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
        elif args[:3] == ["git", "diff", "--find-renames"]:
            stdout = "diff --git a/src/a.py b/src/a.py\n"
        else:
            stdout = ""
        return subprocess.CompletedProcess(args, 0, stdout=stdout, stderr="")

    pr = PullRequestInfo(
        number=12,
        url="https://github.com/nteract/nteract/pull/12",
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
    assert result.diff_patch == "diff --git a/src/a.py b/src/a.py\n"
    assert (
        ["git", "worktree", "add", "--detach", str(workspace), "refs/remotes/origin/pr/12"],
        repo,
    ) in calls


def test_default_workspace_dir_uses_subsecond_suffix(tmp_path: Path) -> None:
    from pr_reviewer.workspace import default_workspace_dir

    first = default_workspace_dir(tmp_path, 12)
    second = default_workspace_dir(tmp_path, 12)

    assert first != second


def test_prepare_review_workspace_removes_worktree_when_diff_collection_fails(
    tmp_path: Path,
) -> None:
    calls: list[tuple[list[str], Path | None]] = []
    repo = tmp_path / "repo"
    repo.mkdir()
    workspace = tmp_path / "review"

    def runner(args: list[str], *, cwd: Path | None = None, check: bool = True):
        calls.append((args, cwd))
        if args[:2] == ["git", "merge-base"]:
            raise subprocess.CalledProcessError(1, args, "merge failed")
        return subprocess.CompletedProcess(args, 0, stdout="", stderr="")

    pr = PullRequestInfo(
        number=12,
        url="https://github.com/nteract/nteract/pull/12",
        title="Patch",
        base_ref="main",
        head_ref="feature",
        head_sha="head",
        base_sha="base",
    )

    with pytest.raises(subprocess.CalledProcessError):
        prepare_review_workspace(repo, pr, workspace_dir=workspace, runner=runner)

    assert (
        ["git", "worktree", "remove", "--force", str(workspace)],
        repo,
    ) in calls
