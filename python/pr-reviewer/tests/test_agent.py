import asyncio
import os
from pathlib import Path

from pr_reviewer import agent
from pr_reviewer.agent import OpencodeRunResult, run_doctor, run_review
from pr_reviewer.config import ReviewerConfig
from pr_reviewer.git import PullRequestInfo
from pr_reviewer.schema import ReviewedDiff
from pr_reviewer.workspace import ReviewWorkspace


def make_workspace(tmp_path: Path) -> ReviewWorkspace:
    return ReviewWorkspace(
        path=tmp_path,
        pr=PullRequestInfo(
            number=5,
            url="https://github.com/nteract/nteract/pull/5",
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


def test_parse_opencode_events_collects_text_session_and_cost() -> None:
    stdout = "\n".join(
        [
            '{"type":"step_start","sessionID":"ses-1","part":{"type":"step-start"}}',
            '{"type":"text","sessionID":"ses-1","part":{"type":"text","text":"{\\"verdict\\": "}}',
            '{"type":"text","sessionID":"ses-1","part":{"type":"text","text":"\\"clear\\"}"}}',
            '{"type":"step_finish","sessionID":"ses-1","part":{"type":"step-finish","cost":0.12}}',
            '{"type":"step_finish","sessionID":"ses-1","part":{"type":"step-finish","cost":0.08}}',
        ]
    )

    result = agent.parse_opencode_events(stdout)

    assert result == OpencodeRunResult(
        text='{"verdict": "clear"}', session_id="ses-1", cost_usd=0.2
    )


def test_parse_structured_review_json_accepts_fenced_json() -> None:
    data = agent.parse_structured_review_json(
        """```json
{"verdict":"clear","terminal_reason":"review_complete","summary":"ok","findings":[]}
```"""
    )

    assert data["verdict"] == "clear"
    assert data["terminal_reason"] == "review_complete"


def test_run_review_uses_opencode_output(monkeypatch, tmp_path: Path) -> None:
    calls = []

    async def fake_run_opencode(
        prompt: str, *, cwd: Path, config: ReviewerConfig
    ) -> OpencodeRunResult:
        calls.append((prompt, cwd, config))
        return OpencodeRunResult(
            text=(
                '{"verdict":"clear","terminal_reason":"review_complete",'
                '"summary":"Looks good.","findings":[]}'
            ),
            session_id="ses-review",
            cost_usd=0.34,
        )

    monkeypatch.setattr(agent, "run_opencode", fake_run_opencode)
    config = ReviewerConfig(model="amazon-bedrock/model", aws_region="us-west-2", max_turns=77)

    report = asyncio.run(run_review(make_workspace(tmp_path), config=config))

    assert report.verdict == "clear"
    assert report.terminal_reason == "review_complete"
    assert report.summary == "Looks good."
    assert report.session_id == "ses-review"
    assert report.model == "amazon-bedrock/model"
    assert report.cost_usd == 0.34
    assert report.raw_result is not None
    assert "diff --git a/src/a.py b/src/a.py" in calls[0][0]
    assert "Do not report style-only comments." in calls[0][0]
    assert calls[0][1] == tmp_path
    assert calls[0][2] == config


def test_run_review_preserves_malformed_output_as_infra_uncertain(
    monkeypatch, tmp_path: Path
) -> None:
    async def fake_run_opencode(
        prompt: str, *, cwd: Path, config: ReviewerConfig
    ) -> OpencodeRunResult:
        return OpencodeRunResult(
            text='{"verdict" "clear"}',
            session_id="ses-review",
            cost_usd=0.34,
        )

    monkeypatch.setattr(agent, "run_opencode", fake_run_opencode)
    config = ReviewerConfig(model="amazon-bedrock/model", aws_region="us-west-2")

    report = asyncio.run(run_review(make_workspace(tmp_path), config=config))

    assert report.verdict == "infra_uncertain"
    assert report.terminal_reason == "infra_uncertain"
    assert "Reviewer returned malformed structured output:" in report.summary
    assert report.findings == []
    assert report.session_id == "ses-review"
    assert report.cost_usd == 0.34
    assert report.raw_result == '{"verdict" "clear"}'


def test_run_doctor_uses_opencode(monkeypatch) -> None:
    calls = []

    async def fake_run_opencode(
        prompt: str, *, cwd: Path | None, config: ReviewerConfig
    ) -> OpencodeRunResult:
        calls.append((prompt, cwd, config))
        return OpencodeRunResult(text="OK.", session_id="ses-doctor", cost_usd=0.01)

    monkeypatch.setattr(agent, "run_opencode", fake_run_opencode)
    config = ReviewerConfig(model="amazon-bedrock/model", aws_region="us-west-2", max_turns=1)

    result = asyncio.run(run_doctor(config))

    assert result == "OK."
    assert calls == [("Reply exactly OK.", None, config)]


def test_build_opencode_env_writes_read_only_config(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("PATH", "/usr/bin")
    monkeypatch.setenv("UNRELATED_SECRET", "do-not-copy")
    monkeypatch.setenv("AWS_PROFILE", "reviewer")
    monkeypatch.setenv("OPENCODE_TOKEN", "token")
    monkeypatch.setenv("OPENCODE_CONFIG", "/tmp/caller-config.json")
    config = ReviewerConfig(model="amazon-bedrock/model", aws_region="us-west-2")

    env = agent.build_opencode_env(config, tmp_path)

    config_path = Path(env["OPENCODE_CONFIG"])
    assert config_path.exists()
    contents = config_path.read_text()
    assert '"edit": "deny"' in contents
    assert '"bash": "allow"' in contents
    assert env["AWS_REGION"] == "us-west-2"
    assert env["AWS_PROFILE"] == "reviewer"
    assert env["OPENCODE_TOKEN"] == "token"
    assert env["OPENCODE_CONFIG"] == str(config_path)
    assert env["PATH"] == "/usr/bin"
    assert "UNRELATED_SECRET" not in env


def test_run_opencode_passes_prompt_on_stdin(monkeypatch, tmp_path: Path) -> None:
    calls = []

    class FakeProcess:
        returncode = 0

        async def communicate(self, stdin: bytes) -> tuple[bytes, bytes]:
            calls.append(("stdin", stdin))
            return (
                b'{"type":"text","sessionID":"ses-1","part":{"type":"text","text":"OK"}}\n',
                b"",
            )

    async def fake_create_subprocess_exec(*command: str, **kwargs: object) -> FakeProcess:
        calls.append(("command", command, kwargs))
        return FakeProcess()

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_create_subprocess_exec)
    monkeypatch.setattr(os, "environ", {"PATH": "/usr/bin", "HOME": "/tmp/home"})
    config = ReviewerConfig(model="amazon-bedrock/model", aws_region="us-west-2")

    result = asyncio.run(agent.run_opencode("large prompt", cwd=tmp_path, config=config))

    assert result.text == "OK"
    command = calls[0][1]
    kwargs = calls[0][2]
    assert command == (
        "opencode",
        "run",
        "--model",
        "amazon-bedrock/model",
        "--format",
        "json",
        "--dir",
        str(tmp_path),
    )
    assert "large prompt" not in command
    assert kwargs["stdin"] == asyncio.subprocess.PIPE
    assert calls[1] == ("stdin", b"large prompt")
