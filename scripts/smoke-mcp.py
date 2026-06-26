"""Cross-platform CI smoke test driving the runtimed daemon over MCP.

Spawns `runt mcp` (or `runt.exe mcp`) over stdio and runs two passes:

  1. Basic: ephemeral notebook, `print(1+1)`, assert stdout == "2".
     Proves install + daemon + IPC + kernel-launch wire up end-to-end.
  2. Polars: ephemeral notebook with `dependencies=["polars"]`, build a
     small DataFrame, render it as the cell's execute_result, assert the
     rendered output contains the expected column names and values.
     Proves uv env resolution + package install + dataframe display.
  3. Optional Viz LLM: ephemeral notebook with pandas/plotly/altair,
     create four cells (imports, DataFrame, Plotly, Altair/Vega-Lite),
     run all cells, and assert the MCP text content includes repr-llm
     summaries for the table and both chart specs. With `--opencode`,
     send only the MCP text content to OpenCode and ask a model for a
     strict JSON verdict that it saw the Plotly LLM summary.

Exits non-zero on any failure.

Usage:
    python scripts/smoke-mcp.py <path-to-runt>
    python scripts/smoke-mcp.py <path-to-runt> --viz-llm
    python scripts/smoke-mcp.py <path-to-runt> --viz-llm --opencode \\
        --opencode-model <provider/model>
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Any

# The MCP server's tool-result formatter uses ━ (U+2501) as a section
# separator. Windows runners default to cp1252, which can't encode that.
# Force UTF-8 on stdout/stderr so the smoke can print every response.
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if sys.stderr.encoding and sys.stderr.encoding.lower() != "utf-8":
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

from mcp import ClientSession, StdioServerParameters  # noqa: E402
from mcp.client.stdio import stdio_client  # noqa: E402

CELL_ID_RE = re.compile(r"cell-[0-9a-f-]{36}")
EXEC_ID_RE = re.compile(r"exec=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})")
DONE_RE = re.compile(r"\bdone\b", re.IGNORECASE)
ERROR_RE = re.compile(r"\berror\b", re.IGNORECASE)
TRANSIENT_KERNEL_LAUNCH_RE = re.compile(
    r"Text file busy \(os error 26\)|Kernel launch timed out or failed",
    re.IGNORECASE,
)
MAX_PASS_ATTEMPTS = 3
UV_POOL_READY_TIMEOUT_SECS = 180
KERNEL_READY_TIMEOUT_SECS = 240


class SmokeRetry(Exception):
    """Raised when a smoke pass hit a transient condition worth retrying."""


def fail(msg: str) -> None:
    print(f"FAIL: {msg}", file=sys.stderr)
    sys.exit(1)


def env_truthy(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in {"1", "true", "yes", "on"}


def content_text_blocks(result) -> list[str]:
    """Return text-typed content blocks from a tool result."""
    return [c.text for c in result.content if hasattr(c, "text")]


def text_of(result) -> str:
    """Concat all text-typed content blocks from a tool result."""
    return "\n".join(content_text_blocks(result))


def content_transcript_of(result) -> str:
    """Render MCP text content blocks with boundaries for LLM harness checks."""
    blocks = content_text_blocks(result)
    return "\n\n".join(
        f"--- MCP content item {index} ---\n{block}" for index, block in enumerate(blocks, 1)
    )


def stdout_of(body: str) -> str:
    """Strip the rich tool formatter's ━━━ banner so we get the kernel output.

    `execute_cell` and `get_results` both return human-formatted text where
    the actual stdout / execute_result body sits after the trailing ━━━
    separator. Newer MCP responses may place an "Output summary" block before
    the rendered output; ignore that summary for this smoke's old exact-output
    assertions.
    """
    parts = body.split("━━━")
    rendered = parts[-1].strip() if len(parts) > 1 else body.strip()
    return strip_output_summary(rendered)


def strip_output_summary(rendered: str) -> str:
    """Remove the leading MCP output-summary block from rendered cell output."""
    lines = rendered.splitlines()
    if not lines:
        return ""

    first = lines[0].strip()
    if first == "Output summary: 0 outputs":
        return "\n".join(lines[1:]).strip()
    if first != "Output summary:":
        return rendered.strip()

    idx = 1
    while idx < len(lines) and re.match(r"^out\[\d+\]:", lines[idx]):
        idx += 1
    return "\n".join(lines[idx:]).strip()


def parse_json_body(body: str) -> dict | None:
    """Best-effort parse for tool responses that are printed as JSON."""
    parsed = parse_json_value(body)
    return parsed if isinstance(parsed, dict) else None


def iter_json_values(body: str):
    """Yield JSON values embedded in text, in source order."""
    text = body.strip()
    if not text:
        return

    try:
        yield json.loads(text)
        return
    except json.JSONDecodeError:
        pass

    decoder = json.JSONDecoder()
    for match in re.finditer(r"[\[{]", text):
        try:
            parsed, _ = decoder.raw_decode(text[match.start() :])
        except json.JSONDecodeError:
            continue
        yield parsed


def parse_json_value(body: str) -> Any | None:
    """Best-effort parse for tool responses that are printed as JSON."""
    return next(iter_json_values(body), None)


def parse_opencode_verdict(body: str) -> dict | None:
    """Parse the first embedded OpenCode verdict object with the expected keys."""
    expected = {"saw_plotly_llm_summary", "plotly_summary_excerpt", "reason"}
    for parsed in iter_json_values(body):
        if isinstance(parsed, dict) and expected.issubset(parsed):
            return parsed
    return None


def kernel_launch_error(body: str) -> str | None:
    """Return create_notebook kernel launch details when the runtime failed."""
    parsed = parse_json_body(body)
    if not parsed:
        return None

    runtime = parsed.get("runtime")
    if not isinstance(runtime, dict) or runtime.get("kernel_status") != "error":
        return None

    details = runtime.get("error_details")
    return str(details) if details else "kernel launch failed"


def int_value(value) -> int:
    """Best-effort integer coercion for daemon status counters."""
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


async def daemon_status(runt_exe: Path) -> dict | None:
    """Read `runt daemon status --json` from the already-started daemon."""
    proc = await asyncio.create_subprocess_exec(
        str(runt_exe),
        "daemon",
        "status",
        "--json",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, _stderr = await proc.communicate()
    if proc.returncode != 0:
        return None

    try:
        parsed = json.loads(stdout.decode("utf-8", errors="replace"))
    except json.JSONDecodeError:
        return None

    return parsed if isinstance(parsed, dict) else None


async def wait_for_uv_pool_ready(runt_exe: Path) -> None:
    """Wait until the smoke's first notebook can claim a prewarmed UV env."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + UV_POOL_READY_TIMEOUT_SECS
    last_summary = ""

    while True:
        status = await daemon_status(runt_exe)
        if status:
            uv = (status.get("pool_stats") or {}).get("uv") or {}
            available = int_value(uv.get("available"))
            warming = int_value(uv.get("warming"))
            pool_size = int_value(uv.get("pool_size"))
            failures = int_value(uv.get("consecutive_failures"))
            retry_in = int_value(uv.get("retry_in_secs"))
            summary = (
                f"available={available} warming={warming} pool_size={pool_size} "
                f"failures={failures} retry_in_secs={retry_in}"
            )

            if available > 0:
                print(f"[smoke] UV pool ready: {summary}")
                return

            if summary != last_summary:
                print(f"[smoke] waiting for UV pool: {summary}")
                last_summary = summary
        elif last_summary != "status-unavailable":
            print("[smoke] waiting for daemon status")
            last_summary = "status-unavailable"

        if loop.time() >= deadline:
            fail(f"UV pool did not become ready within {UV_POOL_READY_TIMEOUT_SECS}s")

        await asyncio.sleep(1)


async def wait_for_kernel_ready(
    session: ClientSession,
    notebook_id: str,
    label: str,
) -> None:
    """Wait for a newly-created smoke notebook's kernel to become executable."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + KERNEL_READY_TIMEOUT_SECS
    last_summary = ""

    while True:
        rooms_result = await session.call_tool("list_active_notebooks", {})
        body = text_of(rooms_result)
        if rooms_result.isError:
            fail(f"[{label}] list_active_notebooks errored while waiting for kernel: {body}")

        rooms = parse_json_value(body)
        room = None
        if isinstance(rooms, list):
            for candidate in rooms:
                if isinstance(candidate, dict) and candidate.get("notebook_id") == notebook_id:
                    room = candidate
                    break

        if isinstance(room, dict):
            status = str(room.get("kernel_status") or "")
            summary = (
                f"has_kernel={room.get('has_kernel')} "
                f"status={status or 'unknown'} "
                f"env_source={room.get('env_source') or 'unknown'}"
            )

            if status in {"idle", "busy"}:
                print(f"[{label}] kernel ready: {summary}")
                return
            if status == "error":
                fail(f"[{label}] kernel entered error state before execute: {body}")
            if summary != last_summary:
                print(f"[{label}] waiting for kernel: {summary}")
                last_summary = summary
        elif last_summary != "room-missing":
            print(f"[{label}] waiting for notebook room {notebook_id}")
            last_summary = "room-missing"

        if loop.time() >= deadline:
            fail(f"[{label}] kernel did not become ready within {KERNEL_READY_TIMEOUT_SECS}s")

        await asyncio.sleep(1)


async def create_notebook_checked(
    session: ClientSession,
    label: str,
    args: dict | None = None,
) -> str:
    """Create a notebook and fail/retry immediately if auto-launch failed."""
    create = await session.call_tool("create_notebook", args or {})
    body = text_of(create)
    if create.isError:
        fail(f"create_notebook({label}) errored: {body}")
    print(body)

    parsed = parse_json_body(body)
    notebook_id = parsed.get("notebook_id") if parsed else None
    if not isinstance(notebook_id, str) or not notebook_id:
        fail(f"create_notebook({label}) did not return notebook_id: {body}")

    error_details = kernel_launch_error(body)
    if not error_details:
        return notebook_id

    message = f"create_notebook({label}) reported kernel launch error: {error_details}"
    if TRANSIENT_KERNEL_LAUNCH_RE.search(error_details):
        raise SmokeRetry(message)
    fail(message)


async def run_smoke_pass(label: str, pass_fn, session: ClientSession) -> None:
    """Run a smoke pass with bounded retries for known launch flakes."""
    for attempt in range(1, MAX_PASS_ATTEMPTS + 1):
        try:
            await pass_fn(session)
            return
        except SmokeRetry as exc:
            if attempt == MAX_PASS_ATTEMPTS:
                fail(f"[{label}] exhausted retries after transient failure: {exc}")

            delay = attempt * 2
            print(f"[{label}] transient failure on attempt {attempt}: {exc}", file=sys.stderr)
            print(f"[{label}] retrying in {delay}s", file=sys.stderr)
            await asyncio.sleep(delay)


async def run_cell_and_get_body(session: ClientSession, source: str, label: str) -> str:
    """Create a code cell, execute it, return the result body once `done`.

    Polls `get_results` for up to 240s to cover the slow path where the
    kernel needs to install dependencies on first execute.
    """
    cell_id = await create_code_cell(session, source, label)

    print(f"[{label}] execute_cell {cell_id}")
    exec_result = await session.call_tool("execute_cell", {"cell_id": cell_id})
    if exec_result.isError:
        fail(f"execute_cell errored: {text_of(exec_result)}")
    print(text_of(exec_result))

    body = text_of(exec_result)
    if DONE_RE.search(body):
        if ERROR_RE.search(body):
            fail(f"execute_cell reported error: {body}")
        return body

    match = EXEC_ID_RE.search(body)
    if not match:
        if "running" in body.lower():
            raise SmokeRetry(f"execute_cell returned running without execution_id: {body}")
        fail(f"could not parse execution_id from execute_cell response: {body}")
    execution_id = match.group(1)
    print(f"[{label}] execution_id={execution_id} - polling get_results")

    for attempt in range(120):
        await asyncio.sleep(2)
        results = await session.call_tool("get_results", {"execution_id": execution_id})
        body = text_of(results)
        if ERROR_RE.search(body) and "Execution not found" not in body:
            fail(f"execution errored: {body}")
        if DONE_RE.search(body):
            print(f"[{label}] result after {attempt * 2}s:")
            print(body)
            return body
        if attempt % 5 == 0:
            print(f"[{label}] attempt {attempt}: still pending")

    fail(f"[{label}] execution did not complete within 240s")


async def create_code_cell(session: ClientSession, source: str, label: str) -> str:
    """Create a code cell and return its cell_id."""
    print(f"[{label}] create_cell")
    cell = await session.call_tool(
        "create_cell",
        {"cell_type": "code", "source": source},
    )
    if cell.isError:
        fail(f"[{label}] create_cell errored: {text_of(cell)}")
    print(text_of(cell))

    match = CELL_ID_RE.search(text_of(cell))
    if not match:
        fail(f"[{label}] could not parse cell_id from create_cell response: {text_of(cell)}")
    return match.group(0)


async def first_cell_id(session: ClientSession, label: str) -> str:
    """Return the current notebook's first cell_id."""
    print(f"[{label}] get_all_cells(format=json, count=1)")
    result = await session.call_tool("get_all_cells", {"format": "json", "count": 1})
    body = text_of(result)
    if result.isError:
        fail(f"[{label}] get_all_cells errored: {body}")

    cells = parse_json_value(body)
    if not isinstance(cells, list) or not cells:
        fail(f"[{label}] get_all_cells returned no cells: {body}")
    cell_id = cells[0].get("cell_id") if isinstance(cells[0], dict) else None
    if not isinstance(cell_id, str) or not cell_id:
        fail(f"[{label}] could not read first cell_id from get_all_cells: {body}")
    return cell_id


async def set_code_cell(session: ClientSession, cell_id: str, source: str, label: str) -> None:
    """Update an existing cell to code with the given source."""
    print(f"[{label}] set_cell {cell_id}")
    result = await session.call_tool(
        "set_cell",
        {"cell_id": cell_id, "cell_type": "code", "source": source},
    )
    if result.isError:
        fail(f"[{label}] set_cell errored: {text_of(result)}")
    print(text_of(result))


async def basic_pass(session: ClientSession, smoke_root: Path) -> None:
    """Sanity-check pass: ephemeral notebook + `print(1+1)`."""
    working_dir = smoke_root / "basic"
    working_dir.mkdir(parents=True, exist_ok=True)

    print("[basic] create_notebook")
    notebook_id = await create_notebook_checked(
        session,
        "basic",
        {"working_dir": str(working_dir)},
    )
    await wait_for_kernel_ready(session, notebook_id, "basic")

    body = await run_cell_and_get_body(session, "print(1 + 1)", "basic")
    out = stdout_of(body)
    if out != "2":
        fail(f"[basic] stdout was {out!r}, expected '2'")
    print("[basic] PASS")


async def polars_pass(session: ClientSession, smoke_root: Path) -> None:
    """Deeper pass: install polars in a fresh uv-backed notebook, render a DataFrame."""
    working_dir = smoke_root / "polars"
    working_dir.mkdir(parents=True, exist_ok=True)

    print("[polars] create_notebook(dependencies=['polars'])")
    notebook_id = await create_notebook_checked(
        session,
        "polars",
        {"dependencies": ["polars"], "working_dir": str(working_dir)},
    )
    await wait_for_kernel_ready(session, notebook_id, "polars")

    # Final expression `df` triggers an execute_result with the polars repr
    # (text/html + text/plain). Asserting on column names and values keeps the
    # test resilient to repr formatting changes (tabular characters, padding).
    src = (
        "import polars as pl\n"
        "df = pl.DataFrame({'name': ['a', 'b', 'c'], 'value': [10, 20, 30]})\n"
        "df\n"
    )
    body = await run_cell_and_get_body(session, src, "polars")
    out = stdout_of(body)

    expected_tokens = ("name", "value", "10", "20", "30")
    missing = [tok for tok in expected_tokens if tok not in out]
    if missing:
        fail(f"[polars] result missing tokens {missing!r}; rendered output was:\n{out}")
    print("[polars] PASS")


VIZ_IMPORT_CELL = """
import pandas as pd
import plotly.express as px
import altair as alt
""".strip()

VIZ_DATAFRAME_CELL = """
df = pd.DataFrame({
    "region": ["north", "south", "east", "west"],
    "revenue": [125, 98, 143, 87],
    "orders": [42, 31, 55, 28],
})
df
""".strip()

VIZ_PLOTLY_CELL = """
fig = px.bar(
    df,
    x="region",
    y="revenue",
    color="orders",
    title="Revenue by Region",
)
fig
""".strip()

VIZ_ALTAIR_CELL = """
chart = alt.Chart(df).mark_circle(size=120).encode(
    x=alt.X("orders:Q", title="Orders"),
    y=alt.Y("revenue:Q", title="Revenue"),
    color="region:N",
    tooltip=["region", "revenue", "orders"],
).properties(title="Revenue vs Orders")
chart
""".strip()


def assert_viz_llm_content(transcript: str) -> None:
    """Assert the model-facing MCP content contains repr-llm summaries."""
    required_snippets = {
        "DataFrame summary": "DataFrame",
        "DataFrame column": "revenue",
        "Plotly LLM summary": "Plotly bar chart",
        "Plotly title": 'Revenue by Region"',
        "Vega-Lite LLM summary": "Vega-Lite circle chart",
        "Vega-Lite encoding": "Encoding:",
    }
    missing = [name for name, snippet in required_snippets.items() if snippet not in transcript]
    if missing:
        fail(
            "[viz-llm] MCP content missing expected repr-llm snippets "
            f"{missing!r}; transcript was:\n{transcript}"
        )


async def run_opencode_plotly_verdict(
    transcript: str,
    model: str | None,
    timeout_secs: float,
    work_dir: Path,
) -> None:
    """Ask OpenCode whether the MCP text transcript exposed the Plotly summary."""
    opencode_bin = os.environ.get("NTERACT_SMOKE_OPENCODE_BIN") or shutil.which("opencode")
    if not opencode_bin:
        fail("[viz-llm] --opencode requested but opencode was not found on PATH")

    prompt = f"""
You are checking whether an MCP tool result exposed an LLM-optimized Plotly chart summary.

Use only the MCP text content transcript below. Do not infer from Python source code. Return true
only if the transcript literally contains an output summary such as "Plotly bar chart".

Return exactly one JSON object and no markdown:
{{
  "saw_plotly_llm_summary": true|false,
  "plotly_summary_excerpt": "short exact excerpt or empty string",
  "reason": "one short sentence"
}}

MCP TEXT CONTENT TRANSCRIPT:
{transcript}
""".strip()

    args = [
        opencode_bin,
        "run",
        "--pure",
        "--format",
        "default",
        "--dir",
        str(work_dir),
    ]
    if model:
        args.extend(["--model", model])
    args.append(prompt)

    model_label = model or "configured default"
    print(f"[viz-llm] opencode verdict using {model_label}")
    proc = await asyncio.create_subprocess_exec(
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout_secs)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.communicate()
        fail(f"[viz-llm] opencode timed out after {timeout_secs}s")

    stdout_text = stdout.decode("utf-8", errors="replace").strip()
    stderr_text = stderr.decode("utf-8", errors="replace").strip()
    if proc.returncode != 0:
        fail(
            f"[viz-llm] opencode exited {proc.returncode}\n"
            f"stdout:\n{stdout_text}\n\nstderr:\n{stderr_text}"
        )
    if stderr_text:
        print(f"[viz-llm] opencode stderr:\n{stderr_text}", file=sys.stderr)
    print(f"[viz-llm] opencode stdout:\n{stdout_text}")

    verdict = parse_opencode_verdict(stdout_text)
    if verdict is None:
        fail(f"[viz-llm] opencode did not return a JSON object: {stdout_text}")
    if verdict.get("saw_plotly_llm_summary") is not True:
        fail(f"[viz-llm] model did not report seeing Plotly LLM summary: {verdict}")
    excerpt = str(verdict.get("plotly_summary_excerpt") or "")
    if "Plotly bar chart" not in excerpt:
        fail(f"[viz-llm] model verdict did not include a Plotly excerpt: {verdict}")


async def viz_llm_pass(
    session: ClientSession,
    smoke_root: Path,
    *,
    run_opencode: bool,
    opencode_model: str | None,
    opencode_timeout_secs: float,
) -> None:
    """Full MCP text-content pass for DataFrame, Plotly, and Altair/Vega summaries."""
    working_dir = smoke_root / "viz-llm"
    working_dir.mkdir(parents=True, exist_ok=True)

    print("[viz-llm] create_notebook(dependencies=['pandas', 'plotly', 'altair'])")
    notebook_id = await create_notebook_checked(
        session,
        "viz-llm",
        {
            "dependencies": ["pandas", "plotly", "altair"],
            "working_dir": str(working_dir),
        },
    )
    await wait_for_kernel_ready(session, notebook_id, "viz-llm")

    import_cell_id = await first_cell_id(session, "viz-llm/imports")
    await set_code_cell(session, import_cell_id, VIZ_IMPORT_CELL, "viz-llm/imports")
    await create_code_cell(session, VIZ_DATAFRAME_CELL, "viz-llm/dataframe")
    await create_code_cell(session, VIZ_PLOTLY_CELL, "viz-llm/plotly")
    await create_code_cell(session, VIZ_ALTAIR_CELL, "viz-llm/altair")

    print("[viz-llm] run_all_cells")
    result = await session.call_tool("run_all_cells", {"timeout_secs": 300})
    transcript = content_transcript_of(result)
    print(transcript)
    if result.isError:
        fail(f"[viz-llm] run_all_cells errored: {transcript}")
    if "Execution completed (4 succeeded)" not in transcript:
        fail(f"[viz-llm] run_all_cells did not report four successful cells:\n{transcript}")

    transcript_path = working_dir / "mcp-content-transcript.txt"
    transcript_path.write_text(transcript, encoding="utf-8")
    print(f"[viz-llm] wrote MCP content transcript: {transcript_path}")

    assert_viz_llm_content(transcript)

    if run_opencode:
        await run_opencode_plotly_verdict(
            transcript,
            opencode_model,
            opencode_timeout_secs,
            working_dir,
        )

    print("[viz-llm] PASS")


async def smoke(
    runt_exe: Path,
    *,
    run_viz_llm: bool,
    run_opencode: bool,
    opencode_model: str | None,
    opencode_timeout_secs: float,
) -> None:
    params = StdioServerParameters(command=str(runt_exe), args=["mcp"])

    async with stdio_client(params) as (read, write), ClientSession(read, write) as session:
        await session.initialize()
        print("[smoke] MCP session initialized")

        tools = await session.list_tools()
        tool_names = sorted(t.name for t in tools.tools)
        print(f"[smoke] {len(tool_names)} tools available")
        for required in (
            "list_active_notebooks",
            "create_notebook",
            "create_cell",
            "set_cell",
            "execute_cell",
            "run_all_cells",
            "get_results",
        ):
            if required not in tool_names:
                fail(f"required tool missing: {required}")

        await wait_for_uv_pool_ready(runt_exe)

        smoke_root_path = Path(tempfile.mkdtemp(prefix="nteract-smoke-"))
        try:
            print(f"[smoke] working directory root: {smoke_root_path}")

            await run_smoke_pass(
                "basic",
                lambda active_session: basic_pass(active_session, smoke_root_path),
                session,
            )
            await run_smoke_pass(
                "polars",
                lambda active_session: polars_pass(active_session, smoke_root_path),
                session,
            )
            if run_viz_llm:
                await run_smoke_pass(
                    "viz-llm",
                    lambda active_session: viz_llm_pass(
                        active_session,
                        smoke_root_path,
                        run_opencode=run_opencode,
                        opencode_model=opencode_model,
                        opencode_timeout_secs=opencode_timeout_secs,
                    ),
                    session,
                )
        finally:
            shutil.rmtree(smoke_root_path, ignore_errors=True)
        print("[smoke] ALL PASSES GREEN")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Cross-platform smoke test driving the runtimed daemon over MCP."
    )
    parser.add_argument("runt_exe", type=Path, help="Path to the runt executable")
    parser.add_argument(
        "--viz-llm",
        action="store_true",
        default=env_truthy("NTERACT_SMOKE_VIZ_LLM"),
        help="Run the optional DataFrame/Plotly/Altair LLM-output MCP content pass",
    )
    parser.add_argument(
        "--opencode",
        action="store_true",
        default=env_truthy("NTERACT_SMOKE_OPENCODE"),
        help="For --viz-llm, ask OpenCode for a model-backed verdict on the MCP content",
    )
    parser.add_argument(
        "--opencode-model",
        default=os.environ.get("NTERACT_SMOKE_OPENCODE_MODEL"),
        help="OpenCode model id, for example provider/model. Also implies --opencode.",
    )
    parser.add_argument(
        "--opencode-timeout-secs",
        type=float,
        default=float(os.environ.get("NTERACT_SMOKE_OPENCODE_TIMEOUT_SECS", "240")),
        help="Timeout for the OpenCode verdict step",
    )
    args = parser.parse_args()

    runt_exe = args.runt_exe
    if not runt_exe.exists():
        fail(f"runt exe not found: {runt_exe}")
    run_opencode = args.opencode or bool(args.opencode_model)
    run_viz_llm = args.viz_llm or run_opencode
    asyncio.run(
        smoke(
            runt_exe,
            run_viz_llm=run_viz_llm,
            run_opencode=run_opencode,
            opencode_model=args.opencode_model,
            opencode_timeout_secs=args.opencode_timeout_secs,
        )
    )


if __name__ == "__main__":
    main()
