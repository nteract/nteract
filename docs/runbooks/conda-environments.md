# Conda notebook environments

Notebooks can use Python 3.12 from Anaconda or conda-forge. The Python 3.13
floor is a default for managed environments without a Python specification,
not a minimum for an explicitly pinned environment. Package availability and
the dependencies you request still determine which versions can solve.

Place an `environment.yml` beside your notebook, for example:

```yaml
name: notebook-python312
channels:
  - main
dependencies:
  - python=3.12
  - numpy
```

The daemon adds the notebook runtime packages, including `ipykernel`, widgets,
and PyArrow. It defaults to regular CPython using an optional `python_abi`
constraint; it does not require the conda-forge-specific `python-gil` package.
Dependency synchronization preserves the installed Python package, including
its version and build, so it cannot silently switch interpreter ABIs.

## Channels

Managed Conda and Pixi environments, including prewarmed pools, resolve:

| Channel | Repository |
|---------|------------|
| `main` | `https://repo.anaconda.com/pkgs/main` |
| `main-x` | `https://repo.anaconda.cloud/repo/main-x` |
| `defaults` | Anaconda `pkgs/main`, `pkgs/r`, plus `pkgs/msys2` on Windows |
| `conda-forge` | `https://conda.anaconda.org/conda-forge` |

Full repository URLs and other channel names also work. Declared order sets
priority. Adding `main-x` does not implicitly add `main`; list both when using
Anaconda's extended package collection. User-owned Pixi projects continue to
use Pixi's own configuration and channel resolution.

## Authentication for main-x

The daemon uses the rattler/Pixi credential store for repository metadata,
package downloads, and lock-based reinstalls. With Pixi installed, Anaconda's
CLI can configure those credentials:

```sh
ana login
ana feature enable main-x --pixi
```

Then add `main-x` after `main` in your environment's channels. An existing
conda-only login may not populate the rattler/Pixi store. `RATTLER_AUTH_FILE`
can select a credential file for the daemon process; keep tokens out of
notebooks and channel URLs.

See [Anaconda CLI's main-x setup](https://github.com/anaconda/anaconda-cli#configuring-conda-and-pixi-for-anaconda-channels)
for authentication setup. Credentials must grant access to the requested
channel; configuring the URL alone does not grant access.
