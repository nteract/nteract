# MathNet Bake-Off

> **Goal for the agent picking this up:** Build a single-file runnable harness that produces the results dataframe slide 5 of the talk needs. Default the harness so a remote-compute box can run it overnight with one env var (`OPENROUTER_API_KEY`) and one shell command.

**Goal:** Score a slate of small open-weight LLMs against a stratified subset of `ShadenA/MathNet`, capture per-attempt diagnostics rich enough that sift's crossfilter sparklines tell the story without further annotation, and emit a parquet file the deck imports the same way it imports the current MathNet manifest.

**Why this exists:** The talk argues *give your agents REPLs.* A static benchmark table is the kind of artifact that argument is *about.* By generating it ourselves end-to-end (load → fan-out → score → display), every slide in the deck demonstrates the thing the deck is arguing for. No metaphor.

**Tech stack:** Python 3.11+, `datasets`, `httpx` (async), `pyarrow`, `tenacity`, OpenRouter as the multi-provider inference transport (one API key, five+ models).

---

## File structure

**New:**
- `decks/talk/experiments/mathnet_bake_off.py` — single-file harness. Sections inside: dataset loading, inference adapter, scoring, parquet writer, CLI.
- `decks/talk/experiments/README.md` — runbook: how to set the API key, how to dry-run, how to do the full overnight sweep, where the parquet lands.
- `decks/talk/experiments/requirements.txt` — pinned deps for a clean remote-compute install.

**Modified later (post-results):**
- `decks/talk/slides.md` — add a results slide that imports the harness's parquet manifest the same way slide 5 imports the MathNet manifest.

---

## Decisions locked in

These are not invitations to debate. Override only if a downstream constraint forces it.

### Problem subset

- Source: `load_dataset("ShadenA/MathNet", "all", split="train[:10000]")`
- Filter: `problem_type != "proof only"` (proof grading is its own research project; we score answer-bearing rows)
- Stratification: balanced across `competition`, capped at `--per-competition` rows per competition (default 5) to avoid one olympiad dominating the sample
- Default size: 500 problems
- Reproducibility: deterministic shuffle with `--seed` (default 42)

### Model slate

All available via OpenRouter so one API key covers all five:

| OpenRouter model id | Notes |
|---|---|
| `qwen/qwen-2.5-7b-instruct` | strong general open model |
| `meta-llama/llama-3.1-8b-instruct` | recognizable baseline |
| `mistralai/mistral-7b-instruct` | classic 7B comparison point |
| `google/gemma-2-9b-it` | google's small-instruct |
| `microsoft/phi-3.5-mini-instruct` | smaller, stronger reasoning ratio |

Plus a control row marked `model="claude-pair"` reserved for the pair-programming demo. We do not invoke Claude through the harness — we union those rows in separately.

### Scoring v1

- Extract prediction:
  1. If the response contains `\boxed{X}`, take `X` (innermost match if nested).
  2. Else, look for the last `$...$` math span; take its content.
  3. Else, take the trailing line and strip trailing punctuation.
- Normalize both prediction and ground truth:
  - Strip whitespace, parentheses around the whole expression, trailing periods
  - Collapse `\frac{a}{b}` → `(a)/(b)`, `\dfrac` → `\frac`, `\,` → ``, `\!` → ``
  - Lowercase `mod`/`pmod` wrappers
  - Sort comma-separated answer lists
- Compare: string equality after normalization
- **Known imperfect.** v1 will mark ~5–10% of actually-correct answers as wrong. Flag in the slide narration. SymPy-based equivalence is v2 and out of scope here.

### Per-row capture

```
problem_id        str    # MathNet id
model             str    # provider/model
competition       str    # joined from MathNet
country           str    # joined
language          str    # joined
problem_type      str    # joined
prediction        str    # extracted from response
ground_truth      str    # MathNet final_answer
correct           bool   # normalized equality
input_tokens      int
output_tokens     int
latency_ms        int
cost_usd          float  # provider price × tokens
reasoning_excerpt str    # first 500 chars of response (the part the audience reads)
attempted_at      str    # ISO 8601 timestamp
```

Schema is sift-friendly: 5 categoricals (model, competition, country, language, problem_type) → crossfilter sparklines; 4 numerics → histograms; 1 bool → ratio bar; 2 free-text → drill-in.

### Storage

- Output: `decks/talk/experiments/results.parquet`
- Incremental: writer flushes every N rows (default 25) so a SIGTERM mid-sweep still produces a partial frame
- Idempotency: on rerun, skip `(model, problem_id)` pairs already present in the existing parquet
- Resume: rerunning the same command after a crash should converge, not duplicate

### Concurrency + cost

- Per-model concurrency: 8 in-flight requests (configurable via `--concurrency`)
- Total budget knob: `--max-cost-usd` aborts the run if accumulated cost would exceed this (default $10)
- Retry: `tenacity` exponential backoff on `httpx.HTTPStatusError 5xx`, `httpx.TimeoutException`, OpenRouter rate-limit responses. 3 attempts, capped 60s between.
- Timeout per request: 120s (math reasoning can be slow on 7B models)

---

## Acceptance criteria

A successful run produces:

1. `decks/talk/experiments/results.parquet` with `5 × 500 = 2,500` rows (or fewer if the cost ceiling kicked in)
2. No duplicates on `(model, problem_id)`
3. Every row has `correct` filled (no nulls)
4. Total cost under the ceiling
5. Schema columns in the order listed above so sift renders them predictably

Additionally:

- `python mathnet_bake_off.py --dry-run --n 10` completes in <90s and writes a 10-row parquet using `microsoft/phi-3.5-mini-instruct` only. This is the smoke test for the remote-compute setup before the full overnight sweep.
- `python mathnet_bake_off.py` (no flags) runs the full sweep with defaults.
- README shows both invocations and the expected output path.

---

## Task list (for the agent picking this up)

- [ ] **T1: Scaffold + deps.** Create `decks/talk/experiments/{mathnet_bake_off.py,README.md,requirements.txt}`. Requirements: `datasets`, `httpx`, `pyarrow`, `pandas`, `tenacity`, `typer` (CLI). Top of the script: docstring + CLI parsing.

- [ ] **T2: Dataset loader.** Function `load_problems(n: int, per_competition: int, seed: int) -> list[Problem]`. Loads `train[:10000]` slice, filters proof-only out, stratified sample across competition with deterministic shuffle. `Problem` dataclass with the joined columns.

- [ ] **T3: Inference adapter.** `class OpenRouterClient: async def generate(model: str, prompt: str) -> Generation` where `Generation` carries text, input_tokens, output_tokens, cost_usd, latency_ms. Uses `httpx.AsyncClient`, sends an OpenRouter-format chat completion. Retries via `tenacity`. Reads API key from `OPENROUTER_API_KEY`.

- [ ] **T4: Scoring.** `extract_answer(response: str) -> str` and `normalize(text: str) -> str` and `score(prediction: str, ground_truth: str) -> bool`. Self-contained module; ship a small unit-test block that runs under `python -m mathnet_bake_off.py --self-test` so the remote-compute box can sanity-check without network.

- [ ] **T5: Parquet writer.** `class IncrementalParquetWriter` with `append(rows: list[dict])` and `flush()`. Reads existing file on init to populate the `(model, problem_id)` skip-set. Uses pyarrow `ParquetWriter` with append mode disabled (one file rewrite per flush is fine at our row counts).

- [ ] **T6: Main loop.** Async fan-out across (model × problem) with `asyncio.gather` batched to `--concurrency`. Accumulates rows, flushes every 25, checks cost ceiling between batches. Logs progress to stderr (one line per N completed).

- [ ] **T7: CLI.** Typer commands: default (full sweep), `--dry-run`, `--self-test`, `--n`, `--per-competition`, `--seed`, `--models`, `--concurrency`, `--max-cost-usd`, `--out`. README documents each.

- [ ] **T8: Dry-run smoke.** Run `python mathnet_bake_off.py --dry-run --n 10` against OpenRouter. Confirm the parquet lands, schema matches spec, all 10 rows have `correct` filled. Spot-check 2-3 normalized scores against the eyeball-correct answer.

- [ ] **T9: README.** Cover: env var, dry-run command, full-sweep command, expected runtime + cost, output path, how to extend with new models.

- [ ] **T10: Commit + push.** Stage all four files, conventional commit `feat(talk): mathnet bake-off harness`. Reference this plan in the body.

**Out of scope for this iteration:** Sympy-based scoring v2, vision-model variants for image-bearing problems, the results slide itself (separate task once we have a parquet).

---

## Open questions for the user

These don't block the harness but they need a call before the overnight sweep:

1. **API key plumbing on remote compute.** Is `OPENROUTER_API_KEY` going to be available there, or should we read from a different env var / secret file?
2. **Cost ceiling.** Default is $10. Sanity-check: at 2,500 generations × ~$0.50/M tokens × ~1k tokens each = ~$1.25 expected, so $10 is a 8× safety margin. OK?
3. **Where to put the parquet for the deck import.** Default is `decks/talk/experiments/results.parquet`. If we want it committed to the repo, it has to fit in git (parquet should be small — 2,500 rows × ~2KB each = ~5MB; under git's comfort zone but probably wants LFS once we add reasoning excerpts).

---

## Decision log

| Date | Decision | Why |
|---|---|---|
| 2026-05-18 | OpenRouter, not direct provider APIs | one key, five+ models, retries handled |
| 2026-05-18 | Skip proof-only problems | grading proofs is its own research project |
| 2026-05-18 | String-normalize equality for v1 | ships tonight; ~5-10% mis-grade rate is acceptable for a demo, will flag in narration |
| 2026-05-18 | Single file, not module | the remote-compute user has one thing to ship, plus one requirements.txt |
| 2026-05-18 | Drop `images`/`solutions_markdown`/`topics_flat` from joined columns | the harness only needs scalars for the result dataframe; images stay out of scope until we wire vision models |
