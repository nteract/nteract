import subprocess
from pathlib import Path

import pytest

from pr_reviewer.architecture_cli import build_parser, read_review_prompt
from pr_reviewer.prompt import build_architecture_prompt
from pr_reviewer.workspace import prepare_architecture_workspace


def run_git(repo: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=repo, check=True, text=True, capture_output=True)


def test_architecture_parser_requires_prompt() -> None:
    parser = build_parser()

    with pytest.raises(SystemExit):
        parser.parse_args([])

    args = parser.parse_args(["--prompt", "Review the architecture boundary."])
    assert args.prompt == "Review the architecture boundary."
    assert args.base == "origin/main"


def test_read_review_prompt_accepts_prompt_file(tmp_path: Path) -> None:
    prompt_file = tmp_path / "prompt.md"
    prompt_file.write_text("Review causal ownership.\n")
    args = build_parser().parse_args(["--prompt-file", str(prompt_file)])

    assert read_review_prompt(args) == "Review causal ownership."


def test_prepare_architecture_workspace_includes_untracked_files(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    run_git(repo, "init")
    run_git(repo, "config", "user.email", "reviewer@example.com")
    run_git(repo, "config", "user.name", "Reviewer")
    (repo / "tracked.py").write_text("print('old')\n")
    run_git(repo, "add", "tracked.py")
    run_git(repo, "commit", "-m", "initial")

    (repo / "tracked.py").write_text("print('new')\n")
    (repo / "draft.py").write_text("print('draft')\n")

    workspace = prepare_architecture_workspace(repo, base_ref="HEAD")

    assert workspace.path == repo
    assert workspace.pr.number == 0
    assert workspace.reviewed_diff.head_ref == "working-tree"
    assert workspace.reviewed_diff.changed_files == ["draft.py", "tracked.py"]
    assert "diff --git a/tracked.py b/tracked.py" in workspace.diff_patch
    assert "diff --git a/draft.py b/draft.py" in workspace.diff_patch


def test_build_architecture_prompt_uses_review_goal(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    run_git(repo, "init")
    run_git(repo, "config", "user.email", "reviewer@example.com")
    run_git(repo, "config", "user.name", "Reviewer")
    (repo / "tracked.py").write_text("print('old')\n")
    run_git(repo, "add", "tracked.py")
    run_git(repo, "commit", "-m", "initial")
    (repo / "tracked.py").write_text("print('new')\n")
    workspace = prepare_architecture_workspace(repo, base_ref="HEAD")

    prompt = build_architecture_prompt(
        workspace,
        review_prompt="Review the security and product architecture.",
    )

    assert "Review this local architecture diff." in prompt
    assert "Review the security and product architecture." in prompt
    assert "- tracked.py" in prompt
    assert "diff --git a/tracked.py b/tracked.py" in prompt
