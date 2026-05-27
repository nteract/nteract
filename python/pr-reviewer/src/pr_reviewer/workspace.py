from __future__ import annotations

import shutil
from dataclasses import dataclass
from datetime import datetime
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
    suffix = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
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


def prepare_architecture_workspace(
    repo_root: Path,
    *,
    base_ref: str = "origin/main",
    head_ref: str = "HEAD",
    include_uncommitted: bool = True,
    runner: git.CommandRunner = git.run,
) -> ReviewWorkspace:
    merge_base = git.merge_base(base_ref, head_ref, cwd=repo_root, runner=runner)
    files = _unique_sorted(
        git.changed_files(base_ref, head_ref, cwd=repo_root, runner=runner)
        + (
            _diff_name_only(
                ["git", "diff", "--find-renames", "--name-only", "--cached", head_ref],
                repo_root,
                runner,
            )
            + _diff_name_only(
                ["git", "diff", "--find-renames", "--name-only", head_ref], repo_root, runner
            )
            + _untracked_files(repo_root, runner)
            if include_uncommitted
            else []
        )
    )
    committed_stat = git.diff_stat(base_ref, head_ref, cwd=repo_root, runner=runner)
    committed_patch = git.diff_patch(base_ref, head_ref, cwd=repo_root, runner=runner)
    stat_parts = [committed_stat]
    patch_parts = [committed_patch]

    if include_uncommitted:
        stat_parts.extend(
            [
                _optional_git_stdout(
                    ["git", "diff", "--find-renames", "--stat", "--cached", head_ref],
                    repo_root,
                    runner,
                ),
                _optional_git_stdout(
                    ["git", "diff", "--find-renames", "--stat", head_ref],
                    repo_root,
                    runner,
                ),
                _untracked_stat(repo_root, runner),
            ]
        )
        patch_parts.extend(
            [
                _optional_git_stdout(
                    ["git", "diff", "--find-renames", "--cached", head_ref],
                    repo_root,
                    runner,
                ),
                _optional_git_stdout(
                    ["git", "diff", "--find-renames", head_ref],
                    repo_root,
                    runner,
                ),
                _untracked_patch(repo_root, runner),
            ]
        )

    title = f"Architecture review for {git.current_branch(repo_root, runner=runner) or head_ref}"
    pr = git.PullRequestInfo(
        number=0,
        url=f"local-diff:{repo_root}",
        title=title,
        base_ref=base_ref,
        head_ref=head_ref,
        head_sha=head_ref,
        base_sha=None,
    )
    head_label = "working-tree" if include_uncommitted else head_ref
    return ReviewWorkspace(
        path=repo_root,
        pr=pr,
        base_ref=base_ref,
        head_ref=head_label,
        reviewed_diff=ReviewedDiff(
            base_ref=base_ref,
            head_ref=head_label,
            merge_base=merge_base,
            changed_files=files,
            diff_stat=_join_nonempty(stat_parts),
        ),
        diff_patch=_join_nonempty(patch_parts),
    )


def remove_review_workspace(
    path: Path, *, repo_root: Path, runner: git.CommandRunner = git.run
) -> None:
    runner(["git", "worktree", "remove", "--force", str(path)], cwd=repo_root, check=False)
    shutil.rmtree(path, ignore_errors=True)


def _unique_sorted(values: list[str]) -> list[str]:
    return sorted({value for value in values if value})


def _diff_name_only(
    args: list[str],
    cwd: Path,
    runner: git.CommandRunner,
) -> list[str]:
    return [line for line in _optional_git_stdout(args, cwd, runner).splitlines() if line]


def _optional_git_stdout(
    args: list[str],
    cwd: Path,
    runner: git.CommandRunner,
) -> str:
    result = runner(args, cwd=cwd, check=False)
    return result.stdout if result.returncode in {0, 1} else ""


def _untracked_files(cwd: Path, runner: git.CommandRunner) -> list[str]:
    result = runner(["git", "ls-files", "--others", "--exclude-standard"], cwd=cwd)
    return [line for line in result.stdout.splitlines() if line]


def _untracked_patch(cwd: Path, runner: git.CommandRunner) -> str:
    patches: list[str] = []
    for path in _untracked_files(cwd, runner):
        full_path = cwd / path
        if not full_path.is_file():
            continue
        result = runner(
            ["git", "diff", "--no-index", "--", "/dev/null", path],
            cwd=cwd,
            check=False,
        )
        if result.stdout:
            patches.append(result.stdout)
    return _join_nonempty(patches)


def _untracked_stat(cwd: Path, runner: git.CommandRunner) -> str:
    entries: list[str] = []
    for path in _untracked_files(cwd, runner):
        full_path = cwd / path
        if not full_path.is_file():
            continue
        line_count = len(full_path.read_text(errors="ignore").splitlines())
        entries.append(f" {path} | {line_count} {'+' * min(line_count, 20)}")
    return "\n".join(entries)


def _join_nonempty(parts: list[str]) -> str:
    return "\n".join(part.rstrip() for part in parts if part and part.strip())
