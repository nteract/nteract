from __future__ import annotations

import shutil
import time
from dataclasses import dataclass
from pathlib import Path

from pr_reviewer import git
from pr_reviewer.schema import ReviewedDiff


@dataclass(frozen=True)
class ReviewWorkspace:
    path: Path
    pr: git.PullRequestInfo
    base_ref: str
    head_ref: str
    reviewed_diff: ReviewedDiff
    diff_patch: str


def default_workspace_dir(repo_root: Path, pr_number: int) -> Path:
    suffix = time.strftime("%Y%m%d-%H%M%S")
    return repo_root / ".context" / "pr-review-workspaces" / f"pr-{pr_number}-{suffix}"


def prepare_review_workspace(
    repo_root: Path,
    pr: git.PullRequestInfo,
    *,
    base_ref: str | None = None,
    workspace_dir: Path | None = None,
    runner: git.CommandRunner = git.run,
) -> ReviewWorkspace:
    base_remote = git.fetch_base(base_ref or pr.base_ref, cwd=repo_root, runner=runner)
    pr_remote = git.fetch_pr(pr.number, cwd=repo_root, runner=runner)

    path = workspace_dir or default_workspace_dir(repo_root, pr.number)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        raise FileExistsError(f"review workspace already exists: {path}")

    runner(["git", "worktree", "add", "--detach", str(path), pr_remote], cwd=repo_root)
    try:
        merge_base = git.merge_base(base_remote, "HEAD", cwd=path, runner=runner)
        files = git.changed_files(base_remote, "HEAD", cwd=path, runner=runner)
        stat = git.diff_stat(base_remote, "HEAD", cwd=path, runner=runner)
        patch = git.diff_patch(base_remote, "HEAD", cwd=path, runner=runner)
    except Exception:
        remove_review_workspace(path, repo_root=repo_root, runner=runner)
        raise

    return ReviewWorkspace(
        path=path,
        pr=pr,
        base_ref=base_remote,
        head_ref="HEAD",
        reviewed_diff=ReviewedDiff(
            base_ref=base_remote,
            head_ref="HEAD",
            merge_base=merge_base,
            changed_files=files,
            diff_stat=stat,
        ),
        diff_patch=patch,
    )


def remove_review_workspace(
    path: Path, *, repo_root: Path, runner: git.CommandRunner = git.run
) -> None:
    runner(["git", "worktree", "remove", "--force", str(path)], cwd=repo_root, check=False)
    shutil.rmtree(path, ignore_errors=True)
