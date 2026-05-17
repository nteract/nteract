import asyncio
import sys
import types
from pathlib import Path

from pr_reviewer.agent import run_doctor, run_review
from pr_reviewer.config import ReviewerConfig
from pr_reviewer.git import PullRequestInfo
from pr_reviewer.schema import ReviewedDiff
from pr_reviewer.workspace import ReviewWorkspace


class FakeSystemMessage:
    def __init__(self) -> None:
        self.subtype = "init"
        self.data = {"session_id": "session-1", "model": "model-from-sdk"}


class FakeResultMessage:
    def __init__(self) -> None:
        self.structured_output = {
            "verdict": "clear",
            "terminal_reason": "review_complete",
            "summary": "Looks good.",
            "findings": [],
        }
        self.session_id = "result-session"
        self.total_cost_usd = 1.25
        self.result = '{"verdict":"clear"}'
        self.is_error = False


class FakeClaudeAgentOptions:
    captured: dict | None = None

    def __init__(self, **kwargs) -> None:
        FakeClaudeAgentOptions.captured = kwargs


async def fake_query(prompt, options):
    chunks = []
    async for chunk in prompt:
        chunks.append(chunk)
    fake_query.chunks = chunks
    fake_query.options = options
    yield FakeSystemMessage()
    yield FakeResultMessage()


fake_query.chunks = []
fake_query.options = None


def install_fake_sdk(monkeypatch) -> None:
    fake_sdk = types.ModuleType("claude_agent_sdk")
    fake_sdk.ClaudeAgentOptions = FakeClaudeAgentOptions
    fake_sdk.ResultMessage = FakeResultMessage
    fake_sdk.SystemMessage = FakeSystemMessage
    fake_sdk.query = fake_query
    monkeypatch.setitem(sys.modules, "claude_agent_sdk", fake_sdk)


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


def test_run_review_constructs_sdk_options_and_report(monkeypatch, tmp_path: Path) -> None:
    install_fake_sdk(monkeypatch)
    config = ReviewerConfig(model="model", aws_region="us-west-2", max_turns=77)

    report = asyncio.run(run_review(make_workspace(tmp_path), config=config))

    assert report.verdict == "clear"
    assert report.terminal_reason == "review_complete"
    assert report.summary == "Looks good."
    assert report.session_id == "session-1"
    assert report.model == "model-from-sdk"
    assert report.cost_usd == 1.25

    options = FakeClaudeAgentOptions.captured
    assert options is not None
    assert options["cwd"] == tmp_path
    assert options["model"] == "model"
    assert options["max_turns"] == 77
    assert options["permission_mode"] == "bypassPermissions"
    assert "Bash" in options["allowed_tools"]
    assert "Write" in options["disallowed_tools"]
    assert options["env"]["CLAUDE_CODE_USE_BEDROCK"] == "1"
    assert options["env"]["AWS_REGION"] == "us-west-2"

    assert fake_query.chunks == [
        {
            "type": "user",
            "message": {
                "role": "user",
                "content": fake_query.chunks[0]["message"]["content"],
            },
        }
    ]
    assert "diff --git a/src/a.py b/src/a.py" in fake_query.chunks[0]["message"]["content"]


def test_run_doctor_uses_streaming_prompt(monkeypatch) -> None:
    install_fake_sdk(monkeypatch)
    config = ReviewerConfig(model="model", aws_region="us-west-2", max_turns=1)

    result = asyncio.run(run_doctor(config))

    assert result == '{"verdict":"clear"}'
    assert fake_query.chunks == [
        {
            "type": "user",
            "message": {"role": "user", "content": "Reply exactly OK."},
        }
    ]
