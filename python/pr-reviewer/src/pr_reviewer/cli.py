from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

from pr_reviewer import git
from pr_reviewer.agent import run_doctor, run_review
from pr_reviewer.config import DEFAULT_MAX_TURNS, ReviewerConfig
from pr_reviewer.report import write_report
from pr_reviewer.workspace import prepare_review_workspace, remove_review_workspace

CLEAR = 0
FINDINGS = 20
NEEDS_HUMAN = 25
INFRA_ERROR = 2


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="pr-review",
        description="Run an isolated Bedrock-backed Claude Agent SDK PR review.",
    )
    add_review_args(parser)
    return parser


def build_doctor_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="pr-review doctor",
        description="Smoke-test Bedrock authentication and model access.",
    )
    add_common_args(parser)
    return parser


def add_common_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--model", default=None)
    parser.add_argument("--aws-region", default=None)
    parser.add_argument("--max-turns", type=int, default=DEFAULT_MAX_TURNS)


def add_review_args(parser: argparse.ArgumentParser) -> None:
    add_common_args(parser)
    parser.add_argument("pr", nargs="?", help="PR number or URL. Omit when using a subcommand.")
    parser.add_argument(
        "--repo", default=None, help="GitHub repo for numeric PR selectors, e.g. owner/name."
    )
    parser.add_argument("--base", default=None, help="Base branch/ref override.")
    parser.add_argument(
        "--workspace", type=Path, default=None, help="Explicit review worktree path."
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=None,
        help="Review JSON output path. Defaults to .context/reviews/pr-<number>.json.",
    )
    parser.add_argument("--extra-prompt", default=None, help="Additional review constraints.")
    parser.add_argument(
        "--cleanup", action="store_true", help="Remove the review worktree after the run."
    )


def config_from_args(args: argparse.Namespace) -> ReviewerConfig:
    return ReviewerConfig.from_env(
        model=args.model,
        aws_region=args.aws_region,
        max_turns=args.max_turns,
        output_path=getattr(args, "out", None),
    )


def run_review_command(args: argparse.Namespace) -> int:
    if not args.pr:
        raise SystemExit("missing PR selector")

    repo_root = git.git_root(Path.cwd())
    pr = git.resolve_pr(git.PullRequestRef(args.pr, repo=args.repo), cwd=repo_root)
    output_path = args.out or repo_root / ".context" / "reviews" / f"pr-{pr.number}.json"
    workspace = prepare_review_workspace(
        repo_root,
        pr,
        base_ref=args.base,
        workspace_dir=args.workspace,
    )

    try:
        report = asyncio.run(
            run_review(
                workspace,
                config=config_from_args(args),
                extra_prompt=args.extra_prompt,
            )
        )
        write_report(
            output_path,
            report,
            metadata={
                "pr": pr.url,
                "workspace": str(workspace.path),
                "cleanup": args.cleanup,
            },
        )
    finally:
        if args.cleanup:
            remove_review_workspace(workspace.path, repo_root=repo_root)

    print(f"review written: {output_path}")
    if report.verdict == "clear":
        return CLEAR
    if report.verdict == "findings":
        return FINDINGS
    if report.verdict == "needs_human":
        return NEEDS_HUMAN
    return INFRA_ERROR


def run_doctor_command(args: argparse.Namespace) -> int:
    config = config_from_args(args)
    result = asyncio.run(run_doctor(config))
    if result.strip() != "OK":
        print(f"doctor returned unexpected response: {result!r}", file=sys.stderr)
        return INFRA_ERROR
    print(f"Bedrock SDK smoke test OK: model={config.model} region={config.aws_region}")
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
        code = run_doctor_command(args) if command == "doctor" else run_review_command(args)
    except Exception as exc:
        print(f"pr-review failed: {exc}", file=sys.stderr)
        raise SystemExit(INFRA_ERROR) from exc
    raise SystemExit(code)


if __name__ == "__main__":
    main()
