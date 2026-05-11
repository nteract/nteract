from pathlib import Path

import pytest

from pr_reviewer import cli
from pr_reviewer.cli import INFRA_UNCERTAIN, build_doctor_parser, build_parser, config_from_args
from pr_reviewer.git import PullRequestInfo
from pr_reviewer.schema import ReviewedDiff, ReviewReport
from pr_reviewer.workspace import ReviewWorkspace


def test_review_parser_accepts_pr_url_without_subcommand() -> None:
    args = build_parser().parse_args(["https://github.com/nteract/desktop/pull/2508"])

    assert args.pr == "https://github.com/nteract/desktop/pull/2508"
    assert args.max_turns is None


def test_doctor_parser_accepts_common_args() -> None:
    args = build_doctor_parser().parse_args(["--model", "model", "--aws-region", "us-west-2"])

    assert args.model == "model"
    assert args.aws_region == "us-west-2"
    assert args.max_turns == 1


def test_config_from_args_respects_model_env(monkeypatch) -> None:
    monkeypatch.setenv("PR_REVIEWER_MODEL", "env-model")
    args = build_parser().parse_args(["2508"])

    assert config_from_args(args).model == "env-model"


def test_config_from_args_preserves_explicit_zero_turns() -> None:
    args = build_parser().parse_args(["2508", "--max-turns", "0"])

    assert config_from_args(args).max_turns == 0


def test_infra_uncertain_exit_code_is_distinct_from_infra_error() -> None:
    assert INFRA_UNCERTAIN == 30


def make_workspace(tmp_path: Path) -> ReviewWorkspace:
    return ReviewWorkspace(
        path=tmp_path / "review",
        pr=PullRequestInfo(
            number=5,
            url="https://github.com/nteract/desktop/pull/5",
            title="Test",
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
        diff_patch="diff --git a/src/a.py b/src/a.py\n",
    )


def install_review_command_fakes(monkeypatch, tmp_path: Path, removed: list[Path]):
    workspace = make_workspace(tmp_path)
    pr = workspace.pr

    monkeypatch.setattr(cli.git, "git_root", lambda cwd: tmp_path)
    monkeypatch.setattr(cli.git, "resolve_pr", lambda pr_ref, cwd: pr)
    monkeypatch.setattr(cli, "prepare_review_workspace", lambda *args, **kwargs: workspace)
    monkeypatch.setattr(
        cli,
        "remove_review_workspace",
        lambda path, *, repo_root: removed.append(path),
    )
    return workspace


def test_cleanup_removes_workspace_when_review_fails(monkeypatch, tmp_path: Path) -> None:
    removed: list[Path] = []
    workspace = install_review_command_fakes(monkeypatch, tmp_path, removed)

    async def fail_review(*args, **kwargs):
        raise RuntimeError("sdk failed")

    monkeypatch.setattr(cli, "run_review", fail_review)
    args = build_parser().parse_args(["5", "--cleanup"])

    with pytest.raises(RuntimeError, match="sdk failed"):
        cli.run_review_command(args)

    assert removed == [workspace.path]


def test_cleanup_keeps_workspace_when_report_write_fails(monkeypatch, tmp_path: Path) -> None:
    removed: list[Path] = []
    install_review_command_fakes(monkeypatch, tmp_path, removed)

    async def pass_review(*args, **kwargs):
        return ReviewReport(verdict="clear", summary="ok")

    monkeypatch.setattr(cli, "run_review", pass_review)

    def fail_write(*args, **kwargs):
        raise OSError("disk full")

    monkeypatch.setattr(cli, "write_report", fail_write)
    args = build_parser().parse_args(["5", "--cleanup"])

    with pytest.raises(OSError, match="disk full"):
        cli.run_review_command(args)

    assert removed == []
