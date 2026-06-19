# pr-reviewer

Internal PR review harness that runs opencode with an Amazon Bedrock model.

The reviewer creates a disposable git worktree for a GitHub PR, asks opencode to
inspect the checked-out PR head and base diff, and writes normalized review
artifacts under `.context/reviews/`.

The opencode session runs in the disposable worktree with a generated
read-only reviewer config that denies `edit` permissions while allowing shell
inspection. Review prompts include the full diff up front so shell inspection
can be used for deeper review instead of basic diff reconstruction.
The shared nteract reviewer rubric lives at
`.agents/reviewers/nteract-code-review-rubric.md`; keep custom Claude, Codex,
Pullfrog, and `pr-reviewer` passes aligned with that file.

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

The default model is `amazon-bedrock/zai.glm-5`.
Set `PR_REVIEWER_OPENCODE=/path/to/opencode` to use a non-default binary.
If opencode's Bedrock adapter returns an empty response for an `amazon-bedrock/`
model, the reviewer falls back to a direct `aws bedrock-runtime converse`
call with the same model ID.

## Model selection

Use `amazon-bedrock/zai.glm-5` as the default cost/performance reviewer. For
cheaper routine alignment passes, try `amazon-bedrock/zai.glm-4.7`; for quick
smoke checks, try `amazon-bedrock/zai.glm-4.7-flash`. Promote newer models only
after they appear in Bedrock and pass both `pr-review doctor` and real PR review
comparisons. Keep model changes explicit in review metadata with `--model` or
`PR_REVIEWER_MODEL` so adversarial review quality can be compared across real
PRs instead of inferred from catalog pricing alone.
