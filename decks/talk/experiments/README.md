# MathNet bake-off

Single-file harness that scores a slate of small open-weight LLMs on a stratified subset of `ShadenA/MathNet` via OpenRouter and emits a sift-friendly parquet.

Plan: `docs/superpowers/plans/2026-05-18-mathnet-bake-off.md`.

## Setup

Python 3.11+. From this directory:

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Set the API key. The harness reads one env var:

```bash
export OPENROUTER_API_KEY=sk-or-v1-...
```

If the key is in a secret file or different env var on the remote box, export it as `OPENROUTER_API_KEY` before invoking the harness.

## Smoke test (no network)

Run the offline scoring tests first to confirm the install is sane:

```bash
python mathnet_bake_off.py --self-test
```

Expected: `self-test passed` on stderr, exit 0. No network calls.

## Dry run

Ten problems against `microsoft/phi-3.5-mini-instruct` only. Validates the OpenRouter request shape and the parquet writer end-to-end:

```bash
python mathnet_bake_off.py --dry-run --n 10
```

Expected: completes in under 90 seconds, writes 10 rows to `decks/talk/experiments/results.parquet`, every row has `correct` filled.

## Full sweep

Defaults match the plan: 5 models, 500 problems each, $10 cost ceiling, deterministic seed 42.

```bash
python mathnet_bake_off.py
```

Expected runtime: 1 to 3 hours overnight depending on provider latency. Expected cost: roughly $1.25 for 2,500 generations at the listed OpenRouter pricing (5 models, ~1k tokens per call). The $10 default ceiling is an 8x safety margin.

The writer is incremental and idempotent. If the run is interrupted, rerunning the same command resumes against the existing parquet and skips `(model, problem_id)` pairs already present.

## Output

Default path: `decks/talk/experiments/results.parquet`. Override with `--out`.

Schema (column order is load-bearing for sift):

| Column | Type | Notes |
|---|---|---|
| `problem_id` | str | MathNet id |
| `model` | str | OpenRouter model id |
| `competition` | str | joined from MathNet |
| `country` | str | joined |
| `language` | str | joined |
| `problem_type` | str | joined |
| `prediction` | str | extracted from response |
| `ground_truth` | str | MathNet `final_answer` |
| `correct` | bool | normalized string equality |
| `input_tokens` | int | from OpenRouter usage |
| `output_tokens` | int | from OpenRouter usage |
| `latency_ms` | int | wall-clock per request |
| `cost_usd` | float | provider-reported or estimated |
| `reasoning_excerpt` | str | first 500 chars of response |
| `attempted_at` | str | ISO 8601 UTC |

Scoring is string equality after normalization. It will mis-grade roughly 5 to 10 percent of actually-correct answers. That's a v1 known-imperfection; flag it in the slide narration. SymPy-based equivalence is v2 and out of scope.

## CLI flags

| Flag | Default | Purpose |
|---|---|---|
| `--n` | 500 | Problems per model |
| `--per-competition` | 5 | Cap per competition during stratification |
| `--seed` | 42 | Deterministic shuffle seed |
| `--models` | (5 default models) | Comma-separated OpenRouter model ids |
| `--concurrency` | 8 | In-flight requests per model |
| `--max-cost-usd` | 10.0 | Abort budget |
| `--out` | `decks/talk/experiments/results.parquet` | Output path |
| `--dry-run` | off | 10-row smoke against phi-3.5-mini |
| `--self-test` | off | Offline scoring/writer tests, no network |

## Adding new models

Edit `DEFAULT_MODELS` in `mathnet_bake_off.py` and add a pricing tuple to `MODEL_PRICING_USD_PER_MTOK` so cost estimation still works when OpenRouter doesn't echo a `cost` field. The schema is model-agnostic, so the deck imports won't care.

The control row reserved for the live pair-programming demo is `model="claude-pair"`. The harness does not invoke Claude. Those rows get unioned in separately when the deck assembles its results frame.

## Troubleshooting

- `OPENROUTER_API_KEY is not set`: the env var didn't reach the process. Export it in the same shell.
- A specific model fails repeatedly: check OpenRouter's status page, then drop it from `--models` and rerun. The skip-set keeps other models' rows.
- Cost ceiling hit: the run aborts mid-batch. Existing rows are flushed to the parquet. Raise `--max-cost-usd` and rerun to continue.
- Schema column missing in sift: the writer pulls columns by name from `SCHEMA_COLUMNS`. Don't reorder that list without touching the deck import.
