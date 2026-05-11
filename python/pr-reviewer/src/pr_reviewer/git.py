from __future__ import annotations

import json
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol


class CommandRunner(Protocol):
    def __call__(
        self,
        args: list[str],
        *,
        cwd: Path | None = None,
        check: bool = True,
    ) -> subprocess.CompletedProcess[str]: ...


def run(
    args: list[str],
    *,
    cwd: Path | None = None,
    check: bool = True,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, cwd=cwd, check=check, text=True, capture_output=True)


@dataclass(frozen=True)
class PullRequestRef:
    value: str
    repo: str | None = None

    @property
    def number(self) -> int | None:
        match = re.search(r"/pull/(\d+)(?:\D|$)", self.value)
        if match:
            return int(match.group(1))
        if self.value.isdigit():
            return int(self.value)
        return None


@dataclass(frozen=True)
class PullRequestInfo:
    number: int
    url: str
    title: str
    base_ref: str
    head_ref: str
    head_sha: str
    base_sha: str | None


def resolve_pr(
    pr: PullRequestRef,
    *,
    cwd: Path,
    runner: CommandRunner = run,
) -> PullRequestInfo:
    selector = pr.value
    args = [
        "gh",
        "pr",
        "view",
        selector,
        "--json",
        "number,url,title,baseRefName,headRefName,headRefOid,baseRefOid",
    ]
    if pr.repo:
        args.extend(["--repo", pr.repo])

    result = runner(args, cwd=cwd)
    data = json.loads(result.stdout)
    return PullRequestInfo(
        number=int(data["number"]),
        url=str(data["url"]),
        title=str(data["title"]),
        base_ref=str(data["baseRefName"]),
        head_ref=str(data["headRefName"]),
        head_sha=str(data["headRefOid"]),
        base_sha=data.get("baseRefOid"),
    )


def git_root(cwd: Path, *, runner: CommandRunner = run) -> Path:
    result = runner(["git", "rev-parse", "--show-toplevel"], cwd=cwd)
    return Path(result.stdout.strip())


def current_branch(cwd: Path, *, runner: CommandRunner = run) -> str:
    result = runner(["git", "branch", "--show-current"], cwd=cwd)
    return result.stdout.strip()


def fetch_pr(pr_number: int, *, cwd: Path, runner: CommandRunner = run) -> str:
    remote_ref = f"refs/remotes/origin/pr/{pr_number}"
    runner(
        ["git", "fetch", "origin", f"+pull/{pr_number}/head:{remote_ref}"],
        cwd=cwd,
    )
    return remote_ref


def fetch_base(base_ref: str, *, cwd: Path, runner: CommandRunner = run) -> str:
    remote_ref = f"origin/{base_ref}"
    runner(
        ["git", "fetch", "origin", f"+refs/heads/{base_ref}:refs/remotes/origin/{base_ref}"],
        cwd=cwd,
    )
    return remote_ref


def merge_base(base_ref: str, head_ref: str, *, cwd: Path, runner: CommandRunner = run) -> str:
    result = runner(["git", "merge-base", base_ref, head_ref], cwd=cwd)
    return result.stdout.strip()


def diff_stat(base_ref: str, head_ref: str, *, cwd: Path, runner: CommandRunner = run) -> str:
    result = runner(
        ["git", "diff", "--find-renames", "--stat", f"{base_ref}...{head_ref}"], cwd=cwd
    )
    return result.stdout


def diff_patch(base_ref: str, head_ref: str, *, cwd: Path, runner: CommandRunner = run) -> str:
    result = runner(["git", "diff", "--find-renames", f"{base_ref}...{head_ref}"], cwd=cwd)
    return result.stdout


def changed_files(
    base_ref: str, head_ref: str, *, cwd: Path, runner: CommandRunner = run
) -> list[str]:
    result = runner(
        ["git", "diff", "--find-renames", "--name-only", f"{base_ref}...{head_ref}"],
        cwd=cwd,
    )
    return [line for line in result.stdout.splitlines() if line]
