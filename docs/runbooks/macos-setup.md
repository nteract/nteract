# macOS Setup Guide

This guide uses Homebrew for system packages, `rustup` for Rust, and `nvm` for
Node. It assumes git, Xcode developer tools, Homebrew, and zsh are installed.

## 1. Install dependencies

### Rust (via rustup)

Install the Rust toolchain with `rustup`. Do not install `rustup` via Homebrew:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

Follow the interactive prompts (the default install is fine).

### Homebrew packages

```bash
brew install nvm llvm git-lfs direnv uv
```

| Package | Purpose |
| --- | --- |
| `nvm` | Node version manager |
| `llvm` | WASM cross-compilation (`sift-wasm` needs clang with a `wasm32` backend; Apple's Xcode clang lacks one) |
| `git-lfs` | LFS-tracked build artifacts in the repo |
| `direnv` | Loads per-worktree env vars automatically on `cd` |
| `uv` | Python package manager |

## 2. Configure shell (`~/.zshrc`)

Add these lines to `~/.zshrc`:

```bash
# Rust (added by rustup installer, ensure it's present)
source "$HOME/.cargo/env"

# nvm
export NVM_DIR="$HOME/.nvm"
[ -s "$(brew --prefix)/opt/nvm/nvm.sh" ] && source "$(brew --prefix)/opt/nvm/nvm.sh"

# direnv
eval "$(direnv hook zsh)"
```

Reload your shell:

```bash
source ~/.zshrc
```

### Optional: silence direnv output

`direnv` prints a line whenever it loads or exports variables on `cd`. To quiet
it, or to clear Powerlevel10k instant-prompt warnings about zsh init output,
add this to `~/.config/direnv/direnv.toml`:

```toml
[global]
hide_env_diff = true
```

### Worktrees and `.envrc`

- `direnv` ties each allow to the `.envrc` path and content, so every new
  worktree starts blocked.
- `scripts/direnv-allow-pinned.sh` allows a worktree's `.envrc` only when it
  matches `main`, leaving changed files blocked for review.
- `scripts/worktree-setup.sh` runs that pinned allow and hydrates Git LFS
  pointer files. Claude Code sessions, subagent worktrees, and Codex worktree
  setup run it automatically; run it manually in hand-created worktrees.
- Avoid a `[whitelist]` prefix in `direnv.toml`. It auto-runs any `.envrc`
  under that path, including untrusted branch changes.

## 3. Global one-time setup

With `PATH` configured, run once per machine:

```bash
# Node 22 (repo is pinned to this via .nvmrc)
nvm install 22

# Git LFS global hooks
git lfs install

# Rust toolchain pinned by rust-toolchain.toml (or let the first cargo command trigger it)
rustup toolchain install 1.99.1

# Cargo tools
cargo install tauri-cli --version "^2" --locked
cargo install wasm-pack --version 0.15.0 --locked
```

## 4. Per-project setup

Clone and initialize the repo:

```bash
git clone https://github.com/nteract/nteract.git
cd nteract
git lfs pull       # hydrate LFS-tracked bundles (required before building)
nvm use            # switches to Node 22 (reads .nvmrc)
direnv allow       # activate per-worktree env vars from .envrc
```

Enable `pnpm` via Corepack (uses the version pinned in `package.json`):

```bash
corepack enable
corepack prepare pnpm@latest --activate
```

> `corepack enable` alone does not download `pnpm`. Run `corepack prepare` so
> `cargo xtask` does not hang waiting for a download prompt.

## 5. First build

Run the full first-run build and dev loop:

```bash
cargo xtask dev
```

`cargo xtask dev` installs `pnpm` dependencies, runs `uv sync`, builds WASM
artifacts and the MCP widget, compiles Rust sidecars, and starts the dev daemon
and Vite dev server. Default builds omit Python bindings because the MCP server
is Rust-native. To iterate on `runtimed-py`, run `cargo xtask integration`
(runs `maturin develop`) or rebuild through `nteract-dev` MCP
(`up rebuild=true`).

Skip slow steps on subsequent launches:

```bash
cargo xtask dev --skip-install   # skip pnpm install if deps haven't changed
cargo xtask dev --skip-build     # reuse existing build artifacts
```

### Development app identity and recovery

Source-built macOS apps run from a per-worktree wrapper in the development
cache, such as `nteract Dev f0f9d9` with bundle identifier
`org.nteract.desktop.dev.f0f9d99b161f`. The wrapper leaves installed Stable and
Nightly apps untouched and does not register notebook file associations.
Release bundle names, identifiers, signing, and packaging stay unchanged.

```bash
cargo xtask dev status  # exact PID, executable, app identity, Vite URL, and socket
cargo xtask dev focus   # activate that exact NSRunningApplication on macOS
cargo xtask dev reset   # stop only this worktree's app and daemon
```

- **Accessibility automation**: Copy `Automation PID` from `dev status` and
  target the System Events process whose `unix id` matches. Never target the
  generic name `nteract`, because LaunchServices may resolve an installed
  Stable or Nightly bundle instead.
- **Stale Tauri state**: Vite handles ordinary frontend hot reload. If a Tauri
  bootstrap or listener is stuck, restart both the daemon and desktop app:

  ```bash
  cargo xtask dev --fresh
  ```

  `--fresh` validates the recorded PID and executable before stopping the app,
  clears stale metadata, stops the worktree daemon socket, and launches a clean
  pair. `direnv allow` is still recommended for interactive shells, though
  `xtask` also exports the worktree namespace explicitly.
