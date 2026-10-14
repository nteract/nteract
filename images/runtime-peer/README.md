# nteract runtime-peer image

A Linux (amd64) container image combining the `runtimed` daemon with a Python
environment at `UV_BASE_PACKAGES` parity, so provider-hosted compute
(Outerbounds workstations, JupyterHub containers) can launch kernels through
the `current_python` policy with **zero manual package installation**.

Design decisions and the kernel-launch mechanics this image relies on live in
`docs/adr/remote-workstation-doc-agents.md`,
`docs/adr/kernel-env-trust.md`, and `crates/kernel-env/src/uv.rs`
(`UV_BASE_PACKAGES` — the single source of truth for the base package set).

## What's inside

| Component | Source | Notes |
|-----------|--------|-------|
| `runtimed` | `cargo build --release -p runtimed` | daemon + `workstation-agent` / `cloud-runtime-agent` |
| `runt`, `nteract-cli` (`nteract` symlink) | `cargo build --release -p runt` | pairing CLI: `workstation connect` / `workstation run` (FR-009) |
| Python 3.12 | `python:3.12-slim-bookworm` | `python3` on `PATH`; pass as `--python-path` |
| `ipykernel`, `ipywidgets`, `anywidget`, `nbformat`, `pyarrow>=14`, `uv` | pip | `UV_BASE_PACKAGES` parity (`crates/kernel-env/src/uv.rs:73-87`); UV-only — no conda (Clarifications 2026-10-01) |
| `runtimed` Python bindings | maturin wheel built in-stage | used by the smoke test; also handy for agents |

The `nteract_kernel_launcher` is **not** preinstalled — the runtime agent
vendors it at launch time via `PYTHONPATH` from its launcher cache
(`crates/runtimed/src/launcher_cache.rs`).

## Build

```bash
git lfs pull   # stable renderer bundles (plotly/vega/leaflet) are LFS-tracked
docker build -t nteract-runtime-peer:dev -f images/runtime-peer/Dockerfile .
```

The builder stage rebuilds the generated wasm + renderer artifacts
(`cargo xtask artifacts ensure runtime,sift,renderer`) because
`crates/runtimed/build.rs` embeds them and panics when missing.

## Validate

```bash
# Full in-container smoke (contract prechecks + daemon execution + launch shape)
bash scripts/ci/runtime-peer-image-smoke.sh nteract-runtime-peer:dev

# Optional: assert the binary version matches an expected release version
bash scripts/ci/runtime-peer-image-smoke.sh nteract-runtime-peer:dev 2.7.6
```

## Run

```bash
# Pair this container with a hosted cloud (credentials via env, never argv)
docker run -it --entrypoint bash nteract-runtime-peer:<tag>
nteract workstation connect https://<cloud-host> --code XXXX-XXXX-XXXX
nteract workstation run --python-path "$(command -v python3)"

# Or directly as the agent entrypoint (token via environment, never argv:
# keep it out of shell history and process lists with an env file)
echo "RUNT_CLOUD_TOKEN=<token>" > runt.env   # chmod 600; delete after use
docker run --rm --env-file runt.env nteract-runtime-peer:<tag> \
  cloud-runtime-agent --cloud-url https://app.runt.run --notebook-id <id> \
  --python-path /usr/local/bin/python3
```

Container contract summary:

- Runs as non-root user `runt` (uid 1000), `HOME=/home/runt` writable — the
  daemon base dir (launcher cache, blobs, socket) lives there; that is the one
  volume requirement.
- `ENTRYPOINT ["runtimed"]`, no default subcommand.
- Outbound network only; no `EXPOSE`d ports (kernel ports bind loopback
  in-container).

## Publication

The release train (`.github/workflows/release-common.yml`, jobs
`image-runtime-peer-build` and `image-runtime-peer-publish`) publishes to
`ghcr.io/nteract/runtime-peer` with `:<version>`, `:<channel>`
(`nightly`/`stable`), and `:latest` (stable only) tags. The build job loads the
image locally, runs the smoke script, then pushes one channel-qualified staging
tag (`build-<channel>-<sha>`) and records its digest. The publish job runs only
after the GitHub release exists and promotes that exact digest with
`docker buildx imagetools create`. A stable tag push and the nightly cron can
build the same commit concurrently; the channel in the staging tag and the
digest handoff keep one channel from publishing the other's image.

Authentication is the job's `GITHUB_TOKEN` with `packages: write`, which can
write only to the repository owner's GHCR namespace. That is why the image lives
under `ghcr.io/nteract/` and not under another org. The reusable workflow's
callers (`release-nightly.yml`, `release-stable.yml`) must grant
`packages: write` in their ceiling or GitHub rejects the whole release at
validation time; every other job in the shared workflow declares
`contents: read` so the scope stays with the two image jobs.

First publish creates the package private. An org admin sets it public once in
the GHCR package settings; until then the publish job's anonymous-pull check
fails. Confirm the package links to `nteract/nteract` (set from the
`org.opencontainers.image.source` label). Pulls need no credentials afterward.

Nightly tags accumulate; GHCR has no retention policy. Pruning old `build-*`
and nightly version tags is a follow-up. Local builds work without any registry.

## Known limitations (v1)

- The publication setup targets linux/amd64 only; local builds follow the host platform (the
  Dockerfile is arch-aware via `TARGETARCH`, so an Apple Silicon daemon
  produces an arm64 image). arm64 publication is a follow-up.
- The runtime base package list is derived from `UV_BASE_PACKAGES` at build
  time, so it floats within the ranges the constant declares (e.g.
  `pyarrow>=14`) — deliberate, so the image always matches daemon-managed
  environments. Build tooling is pinned AND integrity-checked: Node
  `22.23.3`, `pnpm@11.9.0`, `maturin==1.11.5` (matching the release
  workflow's maturin-action), wasm-pack `0.15.0`; the Node and wasm-pack
  tarballs verify against hard-coded SHA256 digests before extraction.
- The BuildKit cache mounts only warm steps within one build (and local
  rebuilds on the same worker); on a fresh CI runner the compile steps still
  cold-pay because cache-mount contents are not exported by
  `--cache-to type=gha`. Wiring sccache (the mechanism `build-linux` and
  `build-python-wheels` use) into the container build is the follow-up that
  removes the ~8-10 min of cold Rust compilation per release.
- In-image first-run onboarding (pairing wizard) is a deferred follow-up —
  operators pair manually with the bundled CLI per the runbook.
- The smoke test's daemon-execution tier lets the local daemon build a uv
  environment, which downloads packages from PyPI (no *cloud* dependency, but
  not airgapped).
