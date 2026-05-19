"""MathNet bake-off harness.

Scores a slate of small open-weight LLMs against a stratified subset of
ShadenA/MathNet via OpenRouter and emits a sift-friendly parquet.

Plan: docs/superpowers/plans/2026-05-18-mathnet-bake-off.md

Usage:
    OPENROUTER_API_KEY=sk-... python mathnet_bake_off.py            # full sweep
    OPENROUTER_API_KEY=sk-... python mathnet_bake_off.py --dry-run  # 10-row smoke
    python mathnet_bake_off.py --self-test                          # offline scoring tests
"""

from __future__ import annotations

import asyncio
import json
import os
import random
import re
import sys
import time
from collections import defaultdict
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import typer

# Schema column order is load-bearing: sift uses positional layout for crossfilter.
SCHEMA_COLUMNS: list[str] = [
    "problem_id",
    "model",
    "competition",
    "country",
    "language",
    "problem_type",
    "prediction",
    "ground_truth",
    "correct",
    "input_tokens",
    "output_tokens",
    "latency_ms",
    "cost_usd",
    "reasoning_excerpt",
    "attempted_at",
]

DEFAULT_MODELS: list[str] = [
    "qwen/qwen-2.5-7b-instruct",
    "meta-llama/llama-3.1-8b-instruct",
    "mistralai/mistral-7b-instruct",
    "google/gemma-2-9b-it",
    "microsoft/phi-3.5-mini-instruct",
]

# OpenRouter prices in USD per 1M tokens. Source: openrouter.ai/models, 2026-05.
# Used when the OpenRouter response does not echo back a `cost` field.
MODEL_PRICING_USD_PER_MTOK: dict[str, tuple[float, float]] = {
    "qwen/qwen-2.5-7b-instruct": (0.04, 0.10),
    "meta-llama/llama-3.1-8b-instruct": (0.05, 0.08),
    "mistralai/mistral-7b-instruct": (0.06, 0.06),
    "google/gemma-2-9b-it": (0.06, 0.06),
    "microsoft/phi-3.5-mini-instruct": (0.10, 0.10),
}

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
SYSTEM_PROMPT = (
    "You are a careful mathematics solver. Solve the problem and put the final "
    "answer inside \\boxed{...}. Show brief reasoning before the boxed answer."
)


# ---------------------------------------------------------------------------
# Dataclasses
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Problem:
    """A single MathNet problem joined with the columns the schema needs."""

    problem_id: str
    competition: str
    country: str
    language: str
    problem_type: str
    problem_markdown: str
    final_answer: str


@dataclass
class Generation:
    """One model response, normalized across providers."""

    text: str
    input_tokens: int
    output_tokens: int
    cost_usd: float
    latency_ms: int


# ---------------------------------------------------------------------------
# Scoring (T4)
# ---------------------------------------------------------------------------


_BOXED_RE = re.compile(r"\\boxed\{")
_MATH_SPAN_RE = re.compile(r"\$([^$]+)\$")


def _find_innermost_boxed(text: str) -> str | None:
    """Return the body of the deepest \\boxed{...} expression, or None."""
    matches: list[str] = []
    for m in _BOXED_RE.finditer(text):
        depth = 1
        i = m.end()
        start = i
        while i < len(text) and depth > 0:
            ch = text[i]
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    matches.append(text[start:i])
                    break
            i += 1
    if not matches:
        return None
    # Innermost = the match with no other match contained inside it.
    matches.sort(key=len)
    return matches[0]


def extract_answer(response: str) -> str:
    """Pull the predicted answer out of a model response."""
    if not response:
        return ""
    boxed = _find_innermost_boxed(response)
    if boxed is not None:
        return boxed.strip()
    spans = _MATH_SPAN_RE.findall(response)
    if spans:
        return spans[-1].strip()
    last_line = response.strip().splitlines()[-1] if response.strip() else ""
    return last_line.rstrip(" .;:!?").strip()


def normalize(text: str) -> str:
    """Normalize a math expression for string-equality scoring."""
    if text is None:
        return ""
    s = str(text).strip()
    # Strip whitespace shorthands first.
    s = s.replace("\\,", "").replace("\\!", "").replace("\\;", "").replace("\\ ", "")
    s = s.replace("\\dfrac", "\\frac").replace("\\tfrac", "\\frac")
    # \frac{a}{b} -> (a)/(b). Iterative so nested fractions collapse.
    frac_re = re.compile(r"\\frac\{([^{}]*)\}\{([^{}]*)\}")
    while True:
        new_s = frac_re.sub(r"(\1)/(\2)", s)
        if new_s == s:
            break
        s = new_s
    # Lowercase pmod/mod wrappers without lowercasing variables.
    s = re.sub(r"\\Pmod", r"\\pmod", s)
    s = re.sub(r"\bMOD\b|\bMod\b", "mod", s)
    # Collapse spaces.
    s = re.sub(r"\s+", "", s)
    # Strip trailing period and surrounding outer parentheses.
    s = s.rstrip(".")
    while s.startswith("(") and s.endswith(")") and _balanced_outer(s):
        s = s[1:-1]
    # Sort comma-separated answer lists (sets like {1,2,3} or 1,2,3).
    if "," in s:
        inner = s
        wrapped = False
        if inner.startswith("{") and inner.endswith("}"):
            inner = inner[1:-1]
            wrapped = True
        parts = [p for p in inner.split(",") if p]
        if len(parts) > 1 and all("=" not in p for p in parts):
            parts.sort()
            inner = ",".join(parts)
            s = "{" + inner + "}" if wrapped else inner
    return s


def _balanced_outer(s: str) -> bool:
    """True iff the outermost parentheses of `s` wrap the entire expression."""
    if len(s) < 2 or s[0] != "(" or s[-1] != ")":
        return False
    depth = 0
    for i, ch in enumerate(s):
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth == 0 and i != len(s) - 1:
                return False
    return depth == 0


def score(prediction: str, ground_truth: str) -> bool:
    """v1 scoring: normalize both sides, compare strings."""
    return normalize(prediction) == normalize(ground_truth) and normalize(ground_truth) != ""


# ---------------------------------------------------------------------------
# Dataset loader (T2)
# ---------------------------------------------------------------------------


def load_problems(n: int, per_competition: int, seed: int) -> list[Problem]:
    """Load and stratify MathNet problems."""
    from datasets import load_dataset  # imported here so --self-test stays offline

    ds = load_dataset("ShadenA/MathNet", "all", split="train[:10000]")
    rows = [r for r in ds if (r.get("problem_type") or "").lower() != "proof only"]

    rng = random.Random(seed)
    rng.shuffle(rows)

    by_competition: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        comp = r.get("competition") or "unknown"
        if len(by_competition[comp]) < per_competition:
            by_competition[comp].append(r)

    picked: list[dict] = []
    for comp, rs in by_competition.items():
        picked.extend(rs)
    rng.shuffle(picked)
    picked = picked[:n]

    return [
        Problem(
            problem_id=str(r.get("id") or ""),
            competition=str(r.get("competition") or ""),
            country=str(r.get("country") or ""),
            language=str(r.get("language") or ""),
            problem_type=str(r.get("problem_type") or ""),
            problem_markdown=str(r.get("problem_markdown") or ""),
            final_answer=str(r.get("final_answer") or ""),
        )
        for r in picked
    ]


# ---------------------------------------------------------------------------
# OpenRouter client (T3)
# ---------------------------------------------------------------------------


class OpenRouterError(RuntimeError):
    """Raised for non-retryable OpenRouter failures."""


class OpenRouterClient:
    """Async client for OpenRouter chat completions with retry."""

    def __init__(self, api_key: str | None = None, timeout_s: float = 120.0) -> None:
        """Bind an httpx client to the OpenRouter endpoint."""
        import httpx

        key = api_key or os.environ.get("OPENROUTER_API_KEY")
        if not key:
            raise OpenRouterError("OPENROUTER_API_KEY is not set")
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(timeout_s),
            headers={
                "Authorization": f"Bearer {key}",
                "Content-Type": "application/json",
                # OpenRouter optional headers for attribution.
                "HTTP-Referer": "https://github.com/nteract/nteract",
                "X-Title": "nteract mathnet bake-off",
            },
        )

    async def aclose(self) -> None:
        """Close the underlying http client."""
        await self._client.aclose()

    async def generate(self, model: str, prompt: str) -> Generation:
        """Send one chat completion request and return a Generation."""
        import httpx
        from tenacity import (
            AsyncRetrying,
            retry_if_exception_type,
            stop_after_attempt,
            wait_exponential,
        )

        payload = {
            "model": model,
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": prompt},
            ],
            "temperature": 0.0,
            "max_tokens": 1024,
            # Ask OpenRouter to include accounting fields when available.
            "usage": {"include": True},
        }

        async for attempt in AsyncRetrying(
            retry=retry_if_exception_type(
                (httpx.TimeoutException, httpx.HTTPStatusError, httpx.TransportError)
            ),
            stop=stop_after_attempt(3),
            wait=wait_exponential(multiplier=1, max=60),
            reraise=True,
        ):
            with attempt:
                t0 = time.perf_counter()
                resp = await self._client.post(OPENROUTER_URL, json=payload)
                if resp.status_code in (429,) or 500 <= resp.status_code < 600:
                    resp.raise_for_status()
                if resp.status_code >= 400:
                    raise OpenRouterError(f"OpenRouter {resp.status_code}: {resp.text[:300]}")
                latency_ms = int((time.perf_counter() - t0) * 1000)
                data = resp.json()
                return _parse_openrouter_response(data, model, latency_ms)
        raise OpenRouterError("retry loop exited without a response")


def _parse_openrouter_response(data: dict, model: str, latency_ms: int) -> Generation:
    """Map an OpenRouter chat completion payload to a Generation."""
    choices = data.get("choices") or []
    text = ""
    if choices:
        msg = choices[0].get("message") or {}
        text = msg.get("content") or ""
    usage = data.get("usage") or {}
    input_tokens = int(usage.get("prompt_tokens") or 0)
    output_tokens = int(usage.get("completion_tokens") or 0)
    cost = usage.get("cost")
    if cost is None:
        cost = estimate_cost(model, input_tokens, output_tokens)
    return Generation(
        text=text,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        cost_usd=float(cost),
        latency_ms=latency_ms,
    )


def estimate_cost(model: str, input_tokens: int, output_tokens: int) -> float:
    """Estimate USD cost from per-Mtok pricing."""
    p_in, p_out = MODEL_PRICING_USD_PER_MTOK.get(model, (0.10, 0.10))
    return (input_tokens / 1_000_000.0) * p_in + (output_tokens / 1_000_000.0) * p_out


# ---------------------------------------------------------------------------
# Parquet writer (T5)
# ---------------------------------------------------------------------------


class IncrementalParquetWriter:
    """Append-flush parquet writer with `(model, problem_id)` dedupe."""

    def __init__(self, path: Path, flush_every: int = 25) -> None:
        """Bind output path, load existing rows for the skip-set."""
        self.path = Path(path)
        self.flush_every = flush_every
        self._buffer: list[dict] = []
        self._seen: set[tuple[str, str]] = set()
        self._existing: list[dict] = []
        if self.path.exists():
            self._load_existing()

    def _load_existing(self) -> None:
        """Read prior rows so reruns can skip already-completed pairs."""
        import pyarrow.parquet as pq

        table = pq.read_table(self.path)
        self._existing = table.to_pylist()
        for row in self._existing:
            key = (str(row.get("model", "")), str(row.get("problem_id", "")))
            self._seen.add(key)

    def already_done(self, model: str, problem_id: str) -> bool:
        """Return True if `(model, problem_id)` is already in the parquet."""
        return (model, problem_id) in self._seen

    def append(self, rows: Iterable[dict]) -> None:
        """Buffer rows and flush when the buffer hits `flush_every`."""
        for row in rows:
            key = (str(row.get("model", "")), str(row.get("problem_id", "")))
            if key in self._seen:
                continue
            self._seen.add(key)
            self._buffer.append(row)
        if len(self._buffer) >= self.flush_every:
            self.flush()

    def flush(self) -> None:
        """Rewrite the parquet from existing + buffered rows."""
        if not self._buffer:
            return
        import pyarrow as pa
        import pyarrow.parquet as pq

        combined = self._existing + self._buffer
        # Force schema column order so sift sees a stable layout.
        ordered = [{col: r.get(col) for col in SCHEMA_COLUMNS} for r in combined]
        table = pa.Table.from_pylist(ordered)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(self.path.suffix + ".tmp")
        pq.write_table(table, tmp)
        tmp.replace(self.path)
        self._existing = combined
        self._buffer = []


# ---------------------------------------------------------------------------
# Main loop (T6)
# ---------------------------------------------------------------------------


@dataclass
class RunConfig:
    """All knobs the main loop reads."""

    models: list[str]
    n: int
    per_competition: int
    seed: int
    concurrency: int
    max_cost_usd: float
    out_path: Path
    flush_every: int = 25


@dataclass
class RunState:
    """Mutable counters shared across the fan-out tasks."""

    total_cost: float = 0.0
    completed: int = 0
    failed: int = 0
    aborted: bool = False
    errors: list[str] = field(default_factory=list)


def build_prompt(problem: Problem) -> str:
    """Format a problem for the model."""
    return (
        f"Problem (competition: {problem.competition}; type: {problem.problem_type}):\n"
        f"\n{problem.problem_markdown}\n\n"
        "Solve and put the final answer inside \\boxed{...}."
    )


def row_from_generation(problem: Problem, model: str, gen: Generation) -> dict:
    """Score a generation and assemble the schema-shaped row."""
    pred = extract_answer(gen.text)
    return {
        "problem_id": problem.problem_id,
        "model": model,
        "competition": problem.competition,
        "country": problem.country,
        "language": problem.language,
        "problem_type": problem.problem_type,
        "prediction": pred,
        "ground_truth": problem.final_answer,
        "correct": score(pred, problem.final_answer),
        "input_tokens": gen.input_tokens,
        "output_tokens": gen.output_tokens,
        "latency_ms": gen.latency_ms,
        "cost_usd": gen.cost_usd,
        "reasoning_excerpt": (gen.text or "")[:500],
        "attempted_at": datetime.now(timezone.utc).isoformat(),
    }


async def _worker(
    client: OpenRouterClient,
    model: str,
    problem: Problem,
    state: RunState,
    sem: asyncio.Semaphore,
) -> dict | None:
    """Issue one (model, problem) request and return a row or None on failure."""
    async with sem:
        if state.aborted:
            return None
        try:
            gen = await client.generate(model, build_prompt(problem))
        except Exception as exc:  # noqa: BLE001
            state.failed += 1
            state.errors.append(f"{model}/{problem.problem_id}: {exc}")
            return None
        state.total_cost += gen.cost_usd
        state.completed += 1
        return row_from_generation(problem, model, gen)


async def run_sweep(cfg: RunConfig) -> RunState:
    """Fan out across (model x problem), flush incrementally, honor cost ceiling."""
    print(
        f"[bake-off] loading {cfg.n} problems (per-competition cap {cfg.per_competition})",
        file=sys.stderr,
    )
    problems = load_problems(cfg.n, cfg.per_competition, cfg.seed)
    print(f"[bake-off] {len(problems)} problems x {len(cfg.models)} models", file=sys.stderr)

    writer = IncrementalParquetWriter(cfg.out_path, flush_every=cfg.flush_every)
    client = OpenRouterClient()
    state = RunState()

    try:
        for model in cfg.models:
            pending = [p for p in problems if not writer.already_done(model, p.problem_id)]
            if not pending:
                print(f"[bake-off] {model}: all rows already present", file=sys.stderr)
                continue
            print(f"[bake-off] {model}: {len(pending)} pending", file=sys.stderr)
            sem = asyncio.Semaphore(cfg.concurrency)

            # Batch into chunks so we can check cost between batches.
            batch_size = max(cfg.concurrency * 4, cfg.flush_every)
            for start in range(0, len(pending), batch_size):
                if state.aborted:
                    break
                batch = pending[start : start + batch_size]
                tasks = [_worker(client, model, p, state, sem) for p in batch]
                results = await asyncio.gather(*tasks)
                rows = [r for r in results if r is not None]
                writer.append(rows)
                print(
                    f"[bake-off] {model}: {state.completed} ok, "
                    f"{state.failed} failed, ${state.total_cost:.4f} spent",
                    file=sys.stderr,
                )
                if state.total_cost >= cfg.max_cost_usd:
                    print(
                        f"[bake-off] cost ceiling ${cfg.max_cost_usd:.2f} hit, aborting",
                        file=sys.stderr,
                    )
                    state.aborted = True
                    break
        writer.flush()
    finally:
        await client.aclose()
    return state


# ---------------------------------------------------------------------------
# Self-test (offline)
# ---------------------------------------------------------------------------


def _self_test() -> int:
    """Offline checks for extract_answer, normalize, score, and the writer."""
    failures: list[str] = []

    def check(label: str, got, want) -> None:
        if got != want:
            failures.append(f"{label}: got {got!r}, want {want!r}")

    # extract_answer
    check("boxed simple", extract_answer("answer is \\boxed{42}"), "42")
    check(
        "boxed nested",
        extract_answer("see \\boxed{\\frac{1}{2}}"),
        "\\frac{1}{2}",
    )
    check(
        "boxed innermost",
        extract_answer("outer \\boxed{ans=\\boxed{7}}"),
        "7",
    )
    check("math span", extract_answer("therefore $x = 5$"), "x = 5")
    check(
        "trailing line",
        extract_answer("step one\nstep two\nfinal: 13."),
        "final: 13",
    )

    # normalize
    check("strip spaces", normalize("  42 "), "42")
    check("frac collapse", normalize("\\frac{1}{2}"), "(1)/(2)")
    check("dfrac alias", normalize("\\dfrac{a}{b}"), "(a)/(b)")
    check("nested frac", normalize("\\frac{\\frac{1}{2}}{3}"), "((1)/(2))/(3)")
    check("thin space", normalize("1\\,000"), "1000")
    check("strip outer paren", normalize("(x+1)"), "x+1")
    check(
        "preserve inner paren",
        normalize("(x+1)+(x-1)"),
        "(x+1)+(x-1)",
    )
    check("sort list", normalize("3,1,2"), "1,2,3")
    check("sort set", normalize("{c,a,b}"), "{a,b,c}")
    check("trailing period", normalize("7."), "7")

    # score
    check("score equal", score("42", "42"), True)
    check("score normalize ws", score(" 42 ", "42"), True)
    check("score frac", score("\\frac{1}{2}", "(1)/(2)"), True)
    check("score list order", score("1,2,3", "3,2,1"), True)
    check("score wrong", score("41", "42"), False)
    check("score blank truth", score("", ""), False)

    # writer dedupe (uses a temp file)
    import tempfile

    with tempfile.TemporaryDirectory() as td:
        out = Path(td) / "results.parquet"
        w = IncrementalParquetWriter(out, flush_every=1)
        row = {col: None for col in SCHEMA_COLUMNS}
        row["problem_id"] = "p1"
        row["model"] = "m"
        row["correct"] = True
        w.append([row])
        w.flush()
        check("writer dedupe", w.already_done("m", "p1"), True)
        # re-open and verify persistence
        w2 = IncrementalParquetWriter(out, flush_every=1)
        check("writer reload", w2.already_done("m", "p1"), True)

    if failures:
        print("self-test FAILED:", file=sys.stderr)
        for f in failures:
            print(f"  - {f}", file=sys.stderr)
        return 1
    print("self-test passed", file=sys.stderr)
    return 0


# ---------------------------------------------------------------------------
# CLI (T7)
# ---------------------------------------------------------------------------


app = typer.Typer(add_completion=False, help=__doc__)


def _parse_models(models: str | None) -> list[str]:
    """Parse a comma-separated --models flag."""
    if not models:
        return list(DEFAULT_MODELS)
    return [m.strip() for m in models.split(",") if m.strip()]


@app.command()
def main(
    n: int = typer.Option(500, "--n", help="Number of problems per model."),
    per_competition: int = typer.Option(
        5, "--per-competition", help="Cap of rows per competition during stratification."
    ),
    seed: int = typer.Option(42, "--seed", help="Deterministic shuffle seed."),
    models: str = typer.Option(None, "--models", help="Comma-separated OpenRouter model ids."),
    concurrency: int = typer.Option(8, "--concurrency", help="In-flight requests per model."),
    max_cost_usd: float = typer.Option(10.0, "--max-cost-usd", help="Abort budget in USD."),
    out: Path = typer.Option(
        Path("decks/talk/experiments/results.parquet"), "--out", help="Parquet output path."
    ),
    dry_run: bool = typer.Option(
        False, "--dry-run", help="10-row smoke test against microsoft/phi-3.5-mini-instruct."
    ),
    self_test: bool = typer.Option(
        False, "--self-test", help="Run offline scoring/writer tests and exit."
    ),
) -> None:
    """Run the MathNet bake-off."""
    if self_test:
        rc = _self_test()
        raise typer.Exit(code=rc)

    if dry_run:
        cfg = RunConfig(
            models=["microsoft/phi-3.5-mini-instruct"],
            n=min(n, 10),
            per_competition=per_competition,
            seed=seed,
            concurrency=min(concurrency, 4),
            max_cost_usd=max_cost_usd,
            out_path=out,
            flush_every=5,
        )
    else:
        cfg = RunConfig(
            models=_parse_models(models),
            n=n,
            per_competition=per_competition,
            seed=seed,
            concurrency=concurrency,
            max_cost_usd=max_cost_usd,
            out_path=out,
        )

    state = asyncio.run(run_sweep(cfg))
    summary = {
        "completed": state.completed,
        "failed": state.failed,
        "aborted": state.aborted,
        "total_cost_usd": round(state.total_cost, 4),
        "out": str(cfg.out_path),
    }
    print(json.dumps(summary, indent=2), file=sys.stderr)
    if state.failed and state.completed == 0:
        raise typer.Exit(code=2)


if __name__ == "__main__":
    app()
