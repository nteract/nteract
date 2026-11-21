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
