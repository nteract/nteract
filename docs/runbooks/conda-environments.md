# Conda notebook environments

Notebooks can use Python 3.12 from Anaconda or conda-forge. The Python 3.13
floor applies only to managed environments without an explicit Python spec.
Package availability and requested dependencies still determine which versions
solve.

Place an `environment.yml` beside your notebook:

```yaml
name: notebook-python312
channels:
  - main
dependencies:
  - python=3.12
  - numpy
```

- **Runtime packages**: The daemon adds `ipykernel`, widgets, and PyArrow
  automatically.
- **Interpreter ABI**: The daemon defaults to regular CPython using an optional
  `python_abi` constraint and does not require `python-gil`. Dependency sync
  preserves the installed Python package (version and build) so it cannot
  silently switch ABIs.
- **Free-threaded Python**: Pin with a bare spec like `python=3.14t`, an
  explicit build, or a regular version constraint plus `python-freethreading`.
  Operator expressions such as `python>=3.14t` are rejected rather than
  selecting a GIL build.

## Installed Jupyter kernels

For local notebooks, the daemon can borrow an installed kernel instead of creating a package environment. An explicit project, environment, or bound prefix takes precedence over an inferred kernel. In Automatic mode a custom `metadata.kernelspec.name` such as `lumen` selects the installed definition, even with captured uv or Conda metadata. A missing definition is an error, not a request for managed Python.

The standard `python3` name alone keeps managed selection. Explicitly applying installed `python3` also saves `metadata.runt.installed_kernelspec: "python3"`. Only the name is portable; paths, argv, and environment values stay on the machine. Staging does not interrupt the running kernel. Apply starts or replaces it. Stage and apply Automatic to return to project or managed selection.

Discovery searches `kernels` below `JUPYTER_PATH` entries, the user Jupyter data directory (`JUPYTER_DATA_DIR` can override it), active Python/Conda prefixes, and system Jupyter data directories. `JUPYTER_PREFER_ENV_PATH=1` puts prefix paths before the user path. Install dependencies with the kernel's own tools: nteract does not sync packages into, or delete, borrowed environments. This is not a JupyterHub or remote-kernel connector. The native integration test runs ipykernel on macOS; Windows runtime behavior is not verified by that test.

## Channels

Managed Conda and Pixi environments, including prewarmed pools, resolve these
aliases:

| Channel | Repository |
|---------|------------|
| `main` | `https://repo.anaconda.com/pkgs/main` |
| `main-x` | `https://repo.anaconda.cloud/repo/main-x` |
| `defaults` | Anaconda `pkgs/main`, `pkgs/r`, plus `pkgs/msys2` on Windows |
| `conda-forge` | `https://conda.anaconda.org/conda-forge` |

- Full repository URLs and other channel names also work. Declared order sets
  priority.
- Adding `main-x` does not implicitly add `main`. List both when using
  Anaconda's extended package collection.
- Package-specific channel prefixes accept these aliases (for example
  `main::numpy` or `main-x::a2wsgi`) alongside the matching channel in the
  channel list.
- User-owned Pixi projects continue to use Pixi's own configuration and channel
  resolution.

## Authentication for main-x

The daemon reads the rattler/Pixi credential store for repository metadata,
package downloads, and lock-based reinstalls.

1. With Pixi installed, configure credentials with Anaconda's CLI:

   ```sh
   ana login
   ana feature enable main-x --pixi
   ```

2. Add `main-x` after `main` in your environment's channels.

Operational notes:

- An existing conda-only login may not populate the rattler/Pixi store.
- Set `RATTLER_AUTH_FILE` to point the daemon at a specific credential file.
  Keep tokens out of notebooks and channel URLs.
- If the credential store fails to load, the daemon logs a warning and
  continues unauthenticated so public channels stay usable. Repair the store
  before downloading private packages.
- Credentials must grant access to the requested channel; configuring the URL
  alone does not grant access. See
  [Anaconda CLI's main-x setup](https://github.com/anaconda/anaconda-cli#configuring-conda-and-pixi-for-anaconda-channels).
