from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

DEFAULT_MODEL = "global.anthropic.claude-opus-4-6-v1"
DEFAULT_AWS_REGION = "us-east-1"
DEFAULT_DOCTOR_MAX_TURNS = 1
DEFAULT_REVIEW_MIN_TURNS = 64
DEFAULT_REVIEW_MAX_TURNS = 200
DEFAULT_EFFORT = "xhigh"

Effort = Literal["low", "medium", "high", "xhigh", "max"]
SettingSource = Literal["user", "project", "local"]


@dataclass(frozen=True)
class ReviewerConfig:
    model: str = DEFAULT_MODEL
    aws_region: str = DEFAULT_AWS_REGION
    max_turns: int = DEFAULT_REVIEW_MIN_TURNS
    effort: Effort = DEFAULT_EFFORT
    output_path: Path | None = None
    setting_sources: list[SettingSource] = field(default_factory=lambda: ["project"])

    @classmethod
    def from_env(
        cls,
        *,
        model: str | None = None,
        aws_region: str | None = None,
        max_turns: int | None = DEFAULT_REVIEW_MIN_TURNS,
        output_path: Path | None = None,
    ) -> ReviewerConfig:
        return cls(
            model=model or os.environ.get("PR_REVIEWER_MODEL", DEFAULT_MODEL),
            aws_region=aws_region or os.environ.get("AWS_REGION", DEFAULT_AWS_REGION),
            max_turns=max_turns if max_turns is not None else DEFAULT_REVIEW_MIN_TURNS,
            output_path=output_path,
        )

    def sdk_env(self) -> dict[str, str]:
        return {
            "CLAUDE_CODE_USE_BEDROCK": "1",
            "AWS_REGION": self.aws_region,
        }


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
