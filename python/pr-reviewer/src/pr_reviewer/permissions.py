from __future__ import annotations

import shlex

READ_ONLY_TOOLS = ["Read", "Glob", "Grep"]
DISALLOWED_TOOLS = [
    "Write",
    "Edit",
    "MultiEdit",
    "NotebookEdit",
    "TodoWrite",
    "WebSearch",
    "WebFetch",
]

_SAFE_GIT_SUBCOMMANDS = {
    "branch",
    "diff",
    "grep",
    "log",
    "ls-files",
    "merge-base",
    "rev-parse",
    "show",
    "status",
}
_SAFE_COMMANDS = {"cat", "git", "nl", "rg", "wc"}
_SHELL_METACHARS = {"|", ">", "<", "&", ";", "$(", "`", "\n", "\r"}
_GIT_WRITE_FLAGS = {"-o", "--output"}


def is_safe_bash_command(command: str) -> bool:
    if any(token in command for token in _SHELL_METACHARS):
        return False

    try:
        parts = shlex.split(command)
    except ValueError:
        return False

    if not parts:
        return False

    executable = parts[0]
    if executable not in _SAFE_COMMANDS:
        return False

    if executable == "git":
        if len(parts) < 2:
            return False
        if parts[1] not in _SAFE_GIT_SUBCOMMANDS:
            return False
        return not any(
            part in _GIT_WRITE_FLAGS or part.startswith("--output=") for part in parts[2:]
        )

    return True


async def review_can_use_tool(tool_name: str, input_data: dict, context: object):
    from claude_agent_sdk.types import PermissionResultAllow, PermissionResultDeny

    if tool_name in READ_ONLY_TOOLS:
        return PermissionResultAllow()

    if tool_name == "Bash":
        command = str(input_data.get("command", ""))
        if is_safe_bash_command(command):
            return PermissionResultAllow()
        return PermissionResultDeny(
            message="Reviewer may only run read-only git/search/file-inspection commands",
            interrupt=True,
        )

    return PermissionResultDeny(
        message=f"{tool_name} is not available in read-only PR review mode",
        interrupt=True,
    )
