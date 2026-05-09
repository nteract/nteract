# nteract-kernel-launcher

Thin wrapper around `ipykernel_launcher` that performs nteract-specific kernel
bootstrap (feature-flagged) before handing control to ipykernel. Designed to be
a drop-in replacement for `python -m ipykernel_launcher`:

```text
python -m nteract_kernel_launcher -f <connection_file>
```

## Bootstrap behavior

When the daemon launches a kernel with `python -m nteract_kernel_launcher`,
the launcher auto-loads its bundled bootstrap extension before user code runs.
The bootstrap registers rich DataFrame, Arrow, and dataset formatters without
requiring the legacy `dx` PyPI package.

If bootstrap raises, the error is logged to stderr but the launcher still
starts the kernel — a broken bootstrap should not prevent the user from
running code.
