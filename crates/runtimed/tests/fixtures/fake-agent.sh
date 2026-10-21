#!/bin/sh
# Stand-in for the agent CLI in run_prompt_cell tests. Tests never write or
# exec a fresh executable (that races with sibling forks: ETXTBSY); they point
# FAKE_AGENT_SCRIPT at a plain snippet that this fixed script sources.
printf '%s\n' "$@" > "$FAKE_AGENT_RECORD.args"
cat > "$FAKE_AGENT_RECORD.stdin"
. "$FAKE_AGENT_SCRIPT"
