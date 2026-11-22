# nteract-kernel-launcher

Thin wrapper around `ipykernel_launcher` that performs nteract-specific kernel
bootstrap (feature-flagged) before handing control to ipykernel. Designed to be
a drop-in replacement for `python -m ipykernel_launcher`:

```text
python -m nteract_kernel_launcher -f <connection_file>
```

## Bootstrap behavior

The daemon launches kernels via `kernel_entry.py nteract_kernel_launcher` (so
files in the current working directory cannot shadow the launcher), while
`python -m nteract_kernel_launcher` remains valid for direct CLI use. Before
user code runs, the launcher auto-loads its bundled bootstrap extension, which
registers rich DataFrame, Arrow, and dataset formatters without requiring the
legacy `dx` PyPI package.

If bootstrap raises, the error is logged to stderr and the launcher still starts the kernel. A broken bootstrap should not prevent the user from running code.

## Output redaction

The launcher performs a first-pass redaction of eligible environment variable values from text-bearing IOPub outputs (`stream`, string display/result MIME data, `error`, and rich tracebacks) before they leave the kernel process. Set `NTERACT_REDACT_ENV_VALUES_IN_OUTPUTS=0` to disable this per kernel.

## Arrow repr bounds

- `NTERACT_ARROW_REPR_MIN_ROWS=<rows>`: minimum head rows retained when the Arrow repr reaches its byte budget.
- `NTERACT_ARROW_REPR_BYTE_BUDGET=<bytes>`: target byte budget for the Arrow repr.
- `NTERACT_ARROW_REPR_MAX_ROWS=<rows>`: maximum head rows retained for the Arrow repr.
