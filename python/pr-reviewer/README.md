# pr-reviewer

Internal PR review harness that runs Claude through the Agent SDK with Amazon
Bedrock authentication.

The reviewer creates a disposable git worktree for a GitHub PR, asks Claude to
inspect the checked-out PR head and base diff, and writes normalized review
artifacts under `.context/reviews/`.

## Usage

```bash
uv run pr-review doctor

uv run pr-review https://github.com/nteract/desktop/pull/2508 \
  --base main \
  --out .context/reviews/pr-2508.json
```

## Bedrock authentication

The harness sets `CLAUDE_CODE_USE_BEDROCK=1` for SDK calls and requires
`AWS_REGION` either in the environment or through `--aws-region`. Credentials
come from the AWS SDK credential chain, such as `AWS_PROFILE`,
`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`, SSO, or
`AWS_BEARER_TOKEN_BEDROCK`.

The default model is `global.anthropic.claude-opus-4-6-v1`.
