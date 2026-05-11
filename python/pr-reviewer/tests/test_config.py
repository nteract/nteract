from pathlib import Path

from pr_reviewer.config import DEFAULT_MODEL, ReviewerConfig


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
