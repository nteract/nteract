from pathlib import Path

from pr_reviewer.config import DEFAULT_MODEL, ReviewerConfig, estimate_review_turns


def test_config_sets_bedrock_env() -> None:
    config = ReviewerConfig(model=DEFAULT_MODEL, aws_region="us-west-2")

    assert config.sdk_env() == {
        "CLAUDE_CODE_USE_BEDROCK": "1",
        "AWS_REGION": "us-west-2",
    }


def test_config_from_env_prefers_explicit_values(monkeypatch) -> None:
    monkeypatch.setenv("AWS_REGION", "us-east-2")
    monkeypatch.setenv("PR_REVIEWER_MODEL", "env-model")

    config = ReviewerConfig.from_env(
        model="explicit-model",
        aws_region="us-west-2",
        output_path=Path("out.json"),
    )

    assert config.model == "explicit-model"
    assert config.aws_region == "us-west-2"
    assert config.output_path == Path("out.json")


def test_config_from_env_preserves_explicit_zero_turns() -> None:
    config = ReviewerConfig.from_env(max_turns=0)

    assert config.max_turns == 0


def test_config_from_env_preserves_empty_model() -> None:
    config = ReviewerConfig.from_env(model="")

    assert config.model == ""


def test_estimate_review_turns_scales_with_diff_size() -> None:
    small = estimate_review_turns(diff_patch="one\nline\n", changed_files=["a.py"])
    larger = estimate_review_turns(
        diff_patch="\n".join(str(i) for i in range(3_000)),
        changed_files=[f"file-{i}.py" for i in range(40)],
    )

    assert small == 64
    assert larger > small
    assert larger <= 200
