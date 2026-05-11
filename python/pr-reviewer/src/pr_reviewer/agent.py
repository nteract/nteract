from __future__ import annotations

from pr_reviewer.config import ReviewerConfig
from pr_reviewer.prompt import SYSTEM_PROMPT, build_review_prompt
from pr_reviewer.schema import REVIEW_SCHEMA, ReviewReport, normalize_structured_output
from pr_reviewer.workspace import ReviewWorkspace

ALLOWED_TOOLS = ["Read", "Glob", "Grep", "Bash"]
DISALLOWED_TOOLS = [
    "Write",
    "Edit",
    "MultiEdit",
    "NotebookEdit",
    "TodoWrite",
    "WebSearch",
    "WebFetch",
]


async def _single_prompt_stream(prompt: str):
    yield {
        "type": "user",
        "message": {"role": "user", "content": prompt},
    }


async def run_review(
    workspace: ReviewWorkspace,
    *,
    config: ReviewerConfig,
    extra_prompt: str | None = None,
) -> ReviewReport:
    from claude_agent_sdk import ClaudeAgentOptions, ResultMessage, SystemMessage, query

    session_id: str | None = None
    model: str | None = config.model
    final: ResultMessage | None = None

    options = ClaudeAgentOptions(
        system_prompt=SYSTEM_PROMPT,
        cwd=workspace.path,
        model=config.model,
        effort=config.effort,
        max_turns=config.max_turns,
        env=config.sdk_env(),
        permission_mode="bypassPermissions",
        allowed_tools=ALLOWED_TOOLS,
        disallowed_tools=DISALLOWED_TOOLS,
        output_format={"type": "json_schema", "schema": REVIEW_SCHEMA},
        setting_sources=config.setting_sources,
        strict_mcp_config=True,
        mcp_servers={},
    )

    prompt = build_review_prompt(workspace, extra_prompt=extra_prompt)
    async for message in query(prompt=_single_prompt_stream(prompt), options=options):
        if isinstance(message, SystemMessage) and message.subtype == "init":
            session_id = message.data.get("session_id")
            model = message.data.get("model") or model
        elif isinstance(message, ResultMessage):
            final = message

    if final is None:
        raise RuntimeError("Claude Agent SDK stream ended without a result message")

    if final.structured_output is None:
        raise RuntimeError(f"review did not return structured output: {final.result!r}")

    verdict, terminal_reason, summary, findings = normalize_structured_output(
        final.structured_output
    )
    return ReviewReport(
        verdict=verdict,
        terminal_reason=terminal_reason,
        summary=summary,
        findings=findings,
        reviewed_diff=workspace.reviewed_diff,
        model=model,
        session_id=session_id or final.session_id,
        workspace=str(workspace.path),
        cost_usd=final.total_cost_usd,
        raw_result=final.result,
    )


async def run_doctor(config: ReviewerConfig) -> str:
    from claude_agent_sdk import ClaudeAgentOptions, ResultMessage, query

    options = ClaudeAgentOptions(
        cwd=None,
        model=config.model,
        effort="low",
        max_turns=1,
        env=config.sdk_env(),
        allowed_tools=[],
        disallowed_tools=["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebSearch", "WebFetch"],
        setting_sources=[],
        strict_mcp_config=True,
        mcp_servers={},
    )
    final: ResultMessage | None = None
    async for message in query(prompt=_single_prompt_stream("Reply exactly OK."), options=options):
        if isinstance(message, ResultMessage):
            final = message
    if final is None:
        raise RuntimeError("doctor stream ended without a result message")
    if final.is_error:
        raise RuntimeError(final.result or "doctor request failed")
    return final.result or ""
