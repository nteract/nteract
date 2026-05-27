from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

from pr_reviewer import git
from pr_reviewer.agent import run_architecture_review, run_doctor
from pr_reviewer.cli import CLEAR, FINDINGS, INFRA_ERROR, INFRA_UNCERTAIN, NEEDS_HUMAN
from pr_reviewer.config import DEFAULT_DOCTOR_MAX_TURNS, ReviewerConfig, estimate_review_turns
from pr_reviewer.report import write_report
from pr_reviewer.workspace import prepare_architecture_workspace


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="architecture-review",
        description="Run an opencode-backed architecture review over a local diff.",
    )
    add_common_args(parser, default_max_turns=None)
    parser.add_argument("--base", default="origin/main", help="Base ref for the local diff.")
    parser.add_argument("--head", default="HEAD", help="Committed head ref for the local diff.")
    parser.add_argument(
        "--repo-root",
        type=Path,
        default=None,
        help="Repository root to review. Defaults to the current git checkout.",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=None,
        help="Review JSON output path. Defaults to .context/reviews/architecture-review.json.",
    )
    parser.add_argument(
        "--committed-only",
        action="store_true",
        help="Exclude staged, unstaged, and untracked working-tree changes.",
    )
    prompt_group = parser.add_mutually_exclusive_group(required=True)
    prompt_group.add_argument("--prompt", help="Architecture review prompt.")
    prompt_group.add_argument(
        "--prompt-file",
        type=Path,
        help="Path to a markdown/text file containing the architecture review prompt.",
    )
    return parser


def build_doctor_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="architecture-review doctor",
        description="Smoke-test opencode model access.",
    )
    add_common_args(parser, default_max_turns=DEFAULT_DOCTOR_MAX_TURNS)
    return parser


def add_common_args(parser: argparse.ArgumentParser, *, default_max_turns: int | None) -> None:
    parser.add_argument("--model", default=None)
    parser.add_argument("--aws-region", default=None)
    parser.add_argument(
        "--max-turns",
        type=int,
        default=default_max_turns,
        help="Advisory review budget recorded in report metadata.",
    )
    parser.add_argument(
        "--timeout-seconds",
        type=float,
        default=None,
        help="Hard wall-clock timeout for the opencode subprocess.",
    )


def config_from_args(args: argparse.Namespace, *, max_turns: int | None = None) -> ReviewerConfig:
    return ReviewerConfig.from_env(
        model=args.model,
        aws_region=args.aws_region,
        max_turns=max_turns if max_turns is not None else args.max_turns,
        timeout_seconds=args.timeout_seconds,
    )


def read_review_prompt(args: argparse.Namespace) -> str:
    if args.prompt_file is not None:
        return args.prompt_file.read_text().strip()
    return str(args.prompt).strip()


def run_architecture_command(args: argparse.Namespace) -> int:
    repo_root = args.repo_root or git.git_root(Path.cwd())
    output_path = args.out or repo_root / ".context" / "reviews" / "architecture-review.json"
    workspace = prepare_architecture_workspace(
        repo_root,
        base_ref=args.base,
        head_ref=args.head,
        include_uncommitted=not args.committed_only,
    )
    max_turns = (
        args.max_turns
        if args.max_turns is not None
        else estimate_review_turns(
            diff_patch=workspace.diff_patch,
            changed_files=workspace.reviewed_diff.changed_files,
        )
    )
    report = asyncio.run(
        run_architecture_review(
            workspace,
            config=config_from_args(args, max_turns=max_turns),
            review_prompt=read_review_prompt(args),
        )
    )
    write_report(
        output_path,
        report,
        metadata={
            "mode": "architecture",
            "workspace": str(workspace.path),
            "base": args.base,
            "head": args.head,
            "include_uncommitted": not args.committed_only,
            "max_turns": max_turns,
        },
    )
    print(f"review written: {output_path}")
    if report.verdict == "clear":
        return CLEAR
    if report.verdict == "findings":
        return FINDINGS
    if report.verdict == "needs_human":
        return NEEDS_HUMAN
    if report.verdict == "infra_uncertain":
        return INFRA_UNCERTAIN
    return INFRA_ERROR


def run_doctor_command(args: argparse.Namespace) -> int:
    config = config_from_args(args)
    result = asyncio.run(run_doctor(config))
    if result.strip().rstrip(".") != "OK":
        print(f"doctor returned unexpected response: {result!r}", file=sys.stderr)
        return INFRA_ERROR
    print(f"opencode smoke test OK: model={config.model} region={config.aws_region}")
    return CLEAR


def main(argv: list[str] | None = None) -> None:
    argv = sys.argv[1:] if argv is None else argv
    if argv and argv[0] == "doctor":
        parser = build_doctor_parser()
        args = parser.parse_args(argv[1:])
        command = "doctor"
    else:
        parser = build_parser()
        args = parser.parse_args(argv)
        command = "review"

    try:
        code = run_doctor_command(args) if command == "doctor" else run_architecture_command(args)
    except Exception as exc:
        print(f"architecture-review failed: {exc}", file=sys.stderr)
        raise SystemExit(INFRA_ERROR) from exc
    raise SystemExit(code)


if __name__ == "__main__":
    main()
