# pr-reviewer

Internal PR review harness that runs opencode with an Amazon Bedrock model.

The reviewer creates a disposable git worktree for a GitHub PR, asks opencode to
inspect the checked-out PR head and base diff, and writes normalized review
artifacts under `.context/reviews/`.

The opencode session runs in the disposable worktree with a generated
read-only reviewer config that denies `edit` permissions while allowing shell
inspection. Review prompts include the full diff up front so shell inspection
can be used for deeper review instead of basic diff reconstruction.

## Usage

```bash
uv run pr-review doctor

uv run pr-review https://github.com/nteract/nteract/pull/2508 \
  --base main \
  --out .context/reviews/pr-2508.json
```

The legacy `--max-turns` option is retained as advisory report metadata for
review sizing, but opencode does not enforce it as a hard turn limit:

```bash
uv run pr-review https://github.com/nteract/nteract/pull/2508 --max-turns 120
```

## opencode authentication

The harness shells out to `opencode run --format json`. Install and configure
opencode normally, then select a model using opencode's provider/model format.
`AWS_REGION` can come from the environment or `--aws-region`, and credentials
come from the AWS SDK credential chain used by opencode's Bedrock provider.

The default model is `amazon-bedrock/global.anthropic.claude-opus-4-6-v1`.
Set `PR_REVIEWER_OPENCODE=/path/to/opencode` to use a non-default binary.
