import asyncio
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
        ]
    )

    result = agent.parse_opencode_events(stdout)

    assert result == OpencodeRunResult(
        text='{"verdict": "clear"}', session_id="ses-1", cost_usd=0.12
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
    assert calls[0][1] == tmp_path
    assert calls[0][2] == config


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


def test_build_opencode_env_writes_read_only_config(tmp_path: Path) -> None:
    config = ReviewerConfig(model="amazon-bedrock/model", aws_region="us-west-2")

    env = agent.build_opencode_env(config, tmp_path)

    config_path = Path(env["OPENCODE_CONFIG"])
    assert config_path.exists()
    contents = config_path.read_text()
    assert '"edit": "deny"' in contents
    assert '"bash": "allow"' in contents
    assert env["AWS_REGION"] == "us-west-2"
