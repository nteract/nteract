# Runtime-peer image: runtimed + notebook Python (linux/amd64 in CI)
#
# Owned by nteract, consumed by providers (Outerbounds workstations, generic
# container runtimes). See images/runtime-peer/README.md and
# docs/runbooks/remote-workstation.md ("The runtime-peer image") for the
# exposed contract and operator flow.
#
# Build prerequisites (documented in images/runtime-peer/README.md):
# - `git lfs pull` first: stable renderer bundles (plotly/vega/leaflet) are
#   LFS-tracked and embedded into the runtimed binary via build.rs.
#
# Stages:
#   1. builder        — Rust + Node/pnpm/wasm-pack + Python (for maturin):
#                       rebuild generated wasm and renderer artifacts, compile
#                       runtimed + runt, build the runtimed Python bindings
#                       wheel (pyo3 abi3-py39 — installs on 3.12 despite being
#                       built against bookworm's 3.11).
#   2. runtime        — python:3.12-slim-bookworm + UV_BASE_PACKAGES parity.
#
# syntax=docker/dockerfile:1

ARG RUST_VERSION=1.94.0
ARG WASM_PACK_VERSION=0.15.0
ARG PYTHON_TAG=3.12-slim-bookworm
ARG PNPM_VERSION=11.9.0
ARG NODE_VERSION=22.23.3
# SHA256 of each pinned tool tarball (verified before extraction; a
# compromised CDN or release asset must not reach the builder that compiles
# the shipped binaries).
ARG NODE_SHA256_X64=1084aa36196bba4c3a5e69a1ee388a6e4ff729dad09445fbcd434b28fe3c24af
ARG NODE_SHA256_ARM64=5ced2d48d1d7198739b7f86804de0171aefb6823b684b12341d3321afc3cb0b2
ARG WASM_PACK_SHA256_X86_64=c09f971ecaed9a2efc80fdcea7a00ef6b53c7fadc8c57d1f61b53a6aa66b668a
ARG WASM_PACK_SHA256_AARCH64=e17ef0806381c3a0acb9c9ddad643a49facaa5a2ecf657a421d4d8f3357a24b7

# ---------------------------------------------------------------------------
# Stage 1: builder — runtimed, runt/nteract-cli, and the bindings wheel
# ---------------------------------------------------------------------------
FROM rust:${RUST_VERSION}-bookworm AS builder

ARG WASM_PACK_VERSION
ARG PNPM_VERSION
ARG NODE_VERSION
ARG NODE_SHA256_X64
ARG NODE_SHA256_ARM64
ARG WASM_PACK_SHA256_X86_64
ARG WASM_PACK_SHA256_AARCH64
# Populated by BuildKit from the target platform (amd64 | arm64). Declare
# without a default so the magic value is not shadowed.
ARG TARGETARCH
# Compile-time release channel baked into the binaries (crates/runt-workspace:
# only "stable" is recognized; empty/unset builds as nightly, matching the
# "building from source is always nightly" house rule). The release workflow
# always passes it explicitly.
ARG RUNT_BUILD_CHANNEL
ENV RUNT_BUILD_CHANNEL=${RUNT_BUILD_CHANNEL}

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates curl xz-utils \
        python3 python3-dev python3-pip \
        clang llvm \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --break-system-packages --no-cache-dir "maturin[patchelf]==1.11.5"

# Pinned Node.js tarball from nodejs.org (npm included), integrity-checked
# against a hard-coded digest — no curl|bash setup scripts and no unverified
# downloads in the release-train build path.
RUN NODE_ARCH="$(case "${TARGETARCH}" in \
        arm64) echo arm64 ;; \
        *) echo x64 ;; \
    esac)" \
    && NODE_SHA256="$(case "${TARGETARCH}" in \
        arm64) echo "${NODE_SHA256_ARM64}" ;; \
        *) echo "${NODE_SHA256_X64}" ;; \
    esac)" \
    && curl -fsSL \
      "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.gz" \
      -o /tmp/node.tar.gz \
    && echo "${NODE_SHA256}  /tmp/node.tar.gz" | sha256sum -c - \
    && tar -xz -C /usr/local --strip-components=1 -f /tmp/node.tar.gz \
    && rm /tmp/node.tar.gz \
    && node --version \
    && npm install --global "pnpm@${PNPM_VERSION}"

# sift-wasm cross-compiles C (zstd-sys) to wasm32; cc-rs needs a clang with
# the wasm32 backend (Debian clang has it) and matching llvm-ar.
ENV CC_wasm32_unknown_unknown=clang \
    AR_wasm32_unknown_unknown=llvm-ar

# Prebuilt wasm-pack (compiling it via cargo install costs several minutes).
# Arch mapping: BuildKit TARGETARCH -> rustwasm release target triple; the
# digest is pinned per-arch and verified before extraction.
RUN WASM_PACK_ARCH="$(case "${TARGETARCH}" in \
        arm64) echo aarch64 ;; \
        *) echo x86_64 ;; \
    esac)" \
    && WASM_PACK_SHA256="$(case "${TARGETARCH}" in \
        arm64) echo "${WASM_PACK_SHA256_AARCH64}" ;; \
        *) echo "${WASM_PACK_SHA256_X86_64}" ;; \
    esac)" \
    && curl -fsSL \
      "https://github.com/rustwasm/wasm-pack/releases/download/v${WASM_PACK_VERSION}/wasm-pack-v${WASM_PACK_VERSION}-${WASM_PACK_ARCH}-unknown-linux-musl.tar.gz" \
      -o /tmp/wasm-pack.tar.gz \
    && echo "${WASM_PACK_SHA256}  /tmp/wasm-pack.tar.gz" | sha256sum -c - \
    && tar -xz -C /usr/local/bin --strip-components=1 -f /tmp/wasm-pack.tar.gz \
    && rm /tmp/wasm-pack.tar.gz \
    && wasm-pack --version

WORKDIR /src

# Copy the workspace source. .dockerignore keeps this lean (no target/,
# node_modules/, .git/). LFS-tracked stable bundles must be real files in the
# build context (run `git lfs pull` before building).
COPY . .

# Generated wasm + renderer artifacts are gitignored but required for build
# (crates/runtimed/build.rs embeds them and panics when missing). Cache
# mounts keep the pnpm store, cargo registry/git dirs, and the build target
# dir warm between steps WITHIN a single build and across local rebuilds on
# the same worker — BuildKit cache mounts are worker-local and are NOT
# exported by --cache-to type=gha, so on a fresh CI runner these steps still
# cold-pay; cross-run Rust compilation needs sccache (used by the sibling
# build jobs) — see README Known limitations.
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    --mount=type=cache,target=/src/target \
    --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    pnpm install --frozen-lockfile \
    && cargo xtask artifacts ensure runtime,sift,renderer

RUN --mount=type=cache,target=/src/target \
    --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    cargo build --release -p runtimed -p runt

# Cache mounts only exist while their RUN executes, so the binaries must be
# surfaced to normal layer paths (/out) from a step that mounts target/ —
# COPY --from in the runtime stage reads /out, never the cache mount.
RUN --mount=type=cache,target=/src/target \
    --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    mkdir -p /out python/runtimed/src/runtimed/_bin \
    && cp target/release/runtimed target/release/runt target/release/nteract-cli /out/ \
    && cp target/release/runtimed python/runtimed/src/runtimed/_bin/runtimed \
    && chmod +x python/runtimed/src/runtimed/_bin/runtimed \
    && cd python/runtimed \
    && maturin build --release -o /wheels

# Derive the runtime base package list from the single source of truth
# (UV_BASE_PACKAGES in crates/kernel-env/src/uv.rs) so the image can never
# drift from it. Parsing rules: strip `//` comments (whole-line and inline)
# BEFORE splitting on commas — a comment containing a comma would otherwise
# leak fragments into the requirements file — then unquote entries. Entries
# may share a line.
RUN python3 <<'PY' > /base-packages.txt
import re

src = open("crates/kernel-env/src/uv.rs").read()
body = re.search(r"UV_BASE_PACKAGES: &\[&str\] = &\[(.*?)\];", src, re.S).group(1)
packages = []
for line in body.splitlines():
    code = line.split("//")[0]
    for piece in code.split(","):
        entry = piece.strip().strip('"')
        if entry:
            packages.append(entry)
assert len(packages) >= 6, packages
assert all("//" not in p and p for p in packages), packages
print("\n".join(packages))
PY

# ---------------------------------------------------------------------------
# Stage 2: runtime — Python 3.12 with the kernel base package set
# ---------------------------------------------------------------------------
FROM python:${PYTHON_TAG} AS runtime

# UV_BASE_PACKAGES parity (crates/kernel-env/src/uv.rs), derived from the
# Rust constant at build time. UV-only — no conda in this image.
COPY --from=builder /base-packages.txt /tmp/base-packages.txt
RUN pip install --no-cache-dir -r /tmp/base-packages.txt \
    && rm -f /tmp/base-packages.txt

COPY --from=builder /wheels/ /tmp/wheels/
RUN pip install --no-cache-dir /tmp/wheels/runtimed-*.whl \
    && rm -rf /tmp/wheels

COPY --from=builder /out/runtimed /usr/local/bin/runtimed
COPY --from=builder /out/runt /usr/local/bin/runt
# The shared `nteract` CLI (crates/runt/src/bin/nteract-cli.rs) provides
# `workstation connect` / `workstation run` pairing (FR-009).
COPY --from=builder /out/nteract-cli /usr/local/bin/nteract-cli
RUN ln -s nteract-cli /usr/local/bin/nteract

COPY images/runtime-peer/smoke.sh /usr/local/share/nteract/smoke.sh
RUN chmod +x /usr/local/share/nteract/smoke.sh

# Non-root operator user; the daemon's base dir (launcher cache, blobs,
# socket) lives under this home and must stay writable (FR-004).
RUN useradd --create-home --uid 1000 --shell /bin/bash runt
USER runt
ENV HOME=/home/runt
WORKDIR /home/runt

# No default subcommand: providers pass workstation-agent /
# cloud-runtime-agent with their own flags. Outbound-only transport, so no
# EXPOSE.
ENTRYPOINT ["runtimed"]
