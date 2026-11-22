# dx

**Smart DataFrame display for Jupyter, built for [nteract](https://nteract.io).**

`dx` upgrades Arrow-stream-capable DataFrames in a notebook. Instead of serializing megabytes of HTML into output cells, `dx` sends Arrow IPC data to nteract's content-addressed blob store and renders it in a fast grid. Your `.ipynb` stays tiny and cells stay snappy. AI agents reading the notebook get a compact per-column summary (dtypes, ranges, distinct/top values, null counts) instead of raw bytes.

## Install

```bash
# pandas
pip install --pre "dx[pandas]"

# polars
pip install --pre "dx[polars]"

# both
pip install --pre "dx[pandas,polars]"
```

Requires Python 3.10+. This PyPI package is frozen at the last published pre-release; no new pre-release or stable wheels are published. See [#2217](https://github.com/nteract/nteract/issues/2217).

Most nteract users do not install `dx` directly. `nteract_kernel_launcher` provides built-in Arrow and DataFrame bootstrap formatting in nteract-managed kernels without requiring `dx`; install `dx` for standalone kernels.

## Use

```python
import dx
dx.install()

import pandas as pd
df = pd.read_parquet("large-dataset.parquet")
df  # rendered via nteract's sift grid (no base64 in your .ipynb)
```

That's it. `dx.install()` is idempotent and intended for standalone kernels or environments not managed by nteract (such as a standalone Jupyter kernel or test harness). In nteract-managed kernels, `nteract_kernel_launcher` provides built-in Arrow and DataFrame bootstrap formatting automatically without `dx`.

## What you get

- **Fast rendering.** Large DataFrames stream through the blob store; the `.ipynb` payload stays small.
- **AI-friendly summaries.** Every DataFrame ships a `text/llm+plain` column summary (dtypes, numeric ranges, string distinct/top values, null counts). Agents reason about the table shape without materializing the whole table.
- **Visualization integration.** [Altair](https://altair-viz.github.io) and [Plotly](https://plotly.com/python/) are automatically switched to their nteract renderers for interactive output inside nteract's isolated iframe sandbox.
- **Arrow protocol first.** pandas, polars, pyarrow, [narwhals](https://narwhals-dev.github.io/narwhals/), and other producers that expose `__arrow_c_stream__()` use the same Arrow IPC path.
- **Safe outside IPython.** `import dx` is always a no-op, and `dx.install()` is a no-op outside IPython (`get_ipython() is None`), making it safe from plain Python, scripts, and CI. Inside IPython, `dx.install()` registers nteract-specific formatters and renderers.

## Links

- Homepage: <https://nteract.io>
- Source & issues: <https://github.com/nteract/nteract>
- License: BSD-3-Clause
