from __future__ import annotations

import os
from dataclasses import dataclass

DEFAULT_MODEL = "amazon-bedrock/global.anthropic.claude-opus-4-6-v1"
DEFAULT_OPENCODE_PATH = "opencode"
DEFAULT_AWS_REGION = "us-east-1"
DEFAULT_DOCTOR_MAX_TURNS = 1
DEFAULT_REVIEW_MIN_TURNS = 64
DEFAULT_REVIEW_MAX_TURNS = 200
DEFAULT_MIN_TIMEOUT_SECONDS = 60.0
DEFAULT_SECONDS_PER_TURN = 30.0


@dataclass(frozen=True)
class ReviewerConfig:
    model: str = DEFAULT_MODEL
    aws_region: str = DEFAULT_AWS_REGION
    max_turns: int = DEFAULT_REVIEW_MIN_TURNS
    opencode_path: str = DEFAULT_OPENCODE_PATH
    timeout_seconds: float | None = None

    @classmethod
    def from_env(
        cls,
        *,
        model: str | None = None,
        aws_region: str | None = None,
        max_turns: int | None = DEFAULT_REVIEW_MIN_TURNS,
        timeout_seconds: float | None = None,
    ) -> ReviewerConfig:
        env_timeout = os.environ.get("PR_REVIEWER_TIMEOUT_SECONDS")
        return cls(
            model=model
            if model is not None
            else os.environ.get("PR_REVIEWER_MODEL", DEFAULT_MODEL),
            aws_region=(
                aws_region
                if aws_region is not None
                else os.environ.get("AWS_REGION", DEFAULT_AWS_REGION)
            ),
            max_turns=max_turns if max_turns is not None else DEFAULT_REVIEW_MIN_TURNS,
            opencode_path=os.environ.get("PR_REVIEWER_OPENCODE", DEFAULT_OPENCODE_PATH),
            timeout_seconds=(
                timeout_seconds
                if timeout_seconds is not None
                else float(env_timeout)
                if env_timeout
                else None
            ),
        )

    def effective_timeout_seconds(self) -> float:
        if self.timeout_seconds is not None:
            return self.timeout_seconds
        return max(DEFAULT_MIN_TIMEOUT_SECONDS, self.max_turns * DEFAULT_SECONDS_PER_TURN)


def estimate_review_turns(
    *,
    diff_patch: str,
    changed_files: list[str],
    floor: int = DEFAULT_REVIEW_MIN_TURNS,
    ceiling: int = DEFAULT_REVIEW_MAX_TURNS,
) -> int:
    diff_lines = len(diff_patch.splitlines())
    file_count = len(changed_files)
    scaled = floor + (diff_lines // 150) + (file_count // 2)
    return min(ceiling, max(floor, scaled))
