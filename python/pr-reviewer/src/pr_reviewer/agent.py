from __future__ import annotations

import asyncio
import json
import os
import tempfile
from dataclasses import dataclass
from json import JSONDecodeError
from pathlib import Path
from typing import Any

from pr_reviewer.config import ReviewerConfig
from pr_reviewer.prompt import SYSTEM_PROMPT, build_review_prompt
from pr_reviewer.schema import ReviewReport, normalize_structured_output
from pr_reviewer.workspace import ReviewWorkspace

PASSTHROUGH_ENV_KEYS = {
    "HOME",
    "LANG",
    "LC_ALL",
    "LOGNAME",
    "PATH",
    "SHELL",
    "TEMP",
    "TMP",
    "TMPDIR",
    "USER",
}

REVIEW_OUTPUT_KEYS = {"verdict", "terminal_reason", "summary", "findings"}


@dataclass(frozen=True)
class OpencodeRunResult:
    text: str
    session_id: str | None
    cost_usd: float | None


def build_opencode_env(config: ReviewerConfig, config_dir: Path) -> dict[str, str]:
    config_dir.mkdir(parents=True, exist_ok=True)
    config_path = config_dir / "opencode-reviewer.json"
    # Keep opencode's normal provider/auth config, but block file edits while
    # still allowing shell inspection in the disposable review workspace.
    config_path.write_text(
        json.dumps(
            {
                "$schema": "https://opencode.ai/config.json",
                "permission": {
                    "bash": "allow",
                    "edit": "deny",
                },
            },
            indent=2,
            sort_keys=True,
        )
        + "\n"
    )

    env = {
        key: value
        for key, value in os.environ.items()
        if key in PASSTHROUGH_ENV_KEYS
        or key.startswith("AWS_")
        or (key.startswith("OPENCODE_") and key != "OPENCODE_CONFIG")
    }
    env["OPENCODE_CONFIG"] = str(config_path)
    if config.aws_region:
        env["AWS_REGION"] = config.aws_region
    return env


def parse_opencode_events(stdout: str) -> OpencodeRunResult:
    text_parts: list[str] = []
    session_id: str | None = None
    cost_usd = 0.0
    saw_cost = False

    for line_number, line in enumerate(stdout.splitlines(), start=1):
        if not line.strip():
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"opencode emitted non-JSON output on line {line_number}") from exc

        if not isinstance(event, dict):
            continue
        session_id = event.get("sessionID") or session_id
        part = event.get("part")
        if isinstance(part, dict) and part.get("type") == "text":
            text = part.get("text")
            if isinstance(text, str):
                text_parts.append(text)
        if isinstance(part, dict) and part.get("type") == "step-finish":
            cost = part.get("cost")
            if isinstance(cost, int | float):
                cost_usd += float(cost)
                saw_cost = True

    return OpencodeRunResult(
        text="".join(text_parts).strip(),
        session_id=session_id,
        cost_usd=cost_usd if saw_cost else None,
    )


def parse_structured_review_json(text: str) -> dict[str, Any]:
    stripped = text.strip()
    if stripped.startswith("```"):
        lines = stripped.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].startswith("```"):
            lines = lines[:-1]
        stripped = "\n".join(lines).strip()

    try:
        parsed = json.loads(stripped)
    except json.JSONDecodeError:
        parsed = parse_last_review_json_object(stripped)

    if not isinstance(parsed, dict):
        raise ValueError("review output JSON was not an object")
    return parsed


def parse_last_review_json_object(text: str) -> dict[str, Any]:
    decoder = json.JSONDecoder()
    candidates: list[dict[str, Any]] = []
    last_error: JSONDecodeError | None = None

    for start, character in enumerate(text):
        if character != "{":
            continue
        try:
            value, _ = decoder.raw_decode(text[start:])
        except JSONDecodeError as exc:
            last_error = exc
            continue
        if isinstance(value, dict) and REVIEW_OUTPUT_KEYS.issubset(value):
            candidates.append(value)

    if candidates:
        return candidates[-1]
    if last_error is not None:
        raise last_error
    raise JSONDecodeError("no JSON object found", text, 0)


def build_infra_uncertain_report(
    *,
    workspace: ReviewWorkspace,
    config: ReviewerConfig,
    run: OpencodeRunResult,
    error: Exception,
) -> ReviewReport:
    return ReviewReport(
        verdict="infra_uncertain",
        terminal_reason="infra_uncertain",
        summary=f"Reviewer returned malformed structured output: {error}",
        findings=[],
        reviewed_diff=workspace.reviewed_diff,
        model=config.model,
        session_id=run.session_id,
        workspace=str(workspace.path),
        cost_usd=run.cost_usd,
        raw_result=run.text,
    )


async def run_opencode(
    prompt: str,
    *,
    cwd: Path | None,
    config: ReviewerConfig,
) -> OpencodeRunResult:
    with tempfile.TemporaryDirectory(prefix="pr-review-opencode-") as temp_dir:
        env = build_opencode_env(config, Path(temp_dir))
        command = [
            config.opencode_path,
            "run",
            "--model",
            config.model,
            "--format",
            "json",
        ]
        if cwd is not None:
            command.extend(["--dir", str(cwd)])

        proc = await asyncio.create_subprocess_exec(
            *command,
            cwd=str(cwd) if cwd is not None else None,
            env=env,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout_bytes, stderr_bytes = await asyncio.wait_for(
                proc.communicate(prompt.encode("utf-8")),
                timeout=config.effective_timeout_seconds(),
            )
        except TimeoutError as exc:
            proc.kill()
            await proc.wait()
            raise RuntimeError(
                f"opencode timed out after {config.effective_timeout_seconds():.1f} seconds"
            ) from exc
        stdout = stdout_bytes.decode("utf-8", errors="replace")
        stderr = stderr_bytes.decode("utf-8", errors="replace")
        if proc.returncode != 0:
            raise RuntimeError(
                f"opencode exited with status {proc.returncode}: {stderr.strip() or stdout.strip()}"
            )
        return parse_opencode_events(stdout)


async def run_review(
    workspace: ReviewWorkspace,
    *,
    config: ReviewerConfig,
    extra_prompt: str | None = None,
) -> ReviewReport:
    prompt = f"{SYSTEM_PROMPT}\n\n{build_review_prompt(workspace, extra_prompt=extra_prompt)}"
    try:
        run = await run_opencode(prompt, cwd=workspace.path, config=config)
        verdict, terminal_reason, summary, findings = normalize_structured_output(
            parse_structured_review_json(run.text)
        )
    except RuntimeError as exc:
        return build_infra_uncertain_report(
            workspace=workspace,
            config=config,
            run=OpencodeRunResult(text="", session_id=None, cost_usd=None),
            error=exc,
        )
    except (JSONDecodeError, ValueError) as exc:
        return build_infra_uncertain_report(
            workspace=workspace,
            config=config,
            run=run,
            error=exc,
        )
    return ReviewReport(
        verdict=verdict,
        terminal_reason=terminal_reason,
        summary=summary,
        findings=findings,
        reviewed_diff=workspace.reviewed_diff,
        model=config.model,
        session_id=run.session_id,
        workspace=str(workspace.path),
        cost_usd=run.cost_usd,
        raw_result=run.text,
    )


async def run_doctor(config: ReviewerConfig) -> str:
    run = await run_opencode("Reply exactly OK.", cwd=None, config=config)
    return run.text
