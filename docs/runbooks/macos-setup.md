# macOS Setup Guide

This guide uses Homebrew for most packages, rustup for Rust, and nvm for Node. It assumes a minimal Mac setup: git, Xcode developer tools, Homebrew, and zsh already installed.

## 1. Install dependencies

### Rust (via rustup)

We want the rust toolchain installed, and the right way to do that is with the rustup script. Do NOT use homebrew for rustup.
```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

Follow the interactive prompts (default install is fine).

### Homebrew packages

```bash
brew install nvm llvm git-lfs direnv uv
```

- **nvm** — Node version manager
- **llvm** — required for WASM cross-compilation (`sift-wasm` needs a clang with a wasm32 backend; Apple's Xcode clang does not have one)
- **git-lfs** — for LFS-tracked build artifacts in the repo
- **direnv** — sets per-worktree env vars automatically on `cd`
- **uv** — Python package manager

## 2. Configure shell (`~/.zshrc`)

The following belongs in `~/.zshrc`, configuring the dependencies installed above

```bash
# Rust (added by rustup installer, ensure it's present)
source "$HOME/.cargo/env"

# nvm
export NVM_DIR="$HOME/.nvm"
[ -s "$(brew --prefix)/opt/nvm/nvm.sh" ] && source "$(brew --prefix)/opt/nvm/nvm.sh"

# direnv
eval "$(direnv hook zsh)"
```

Then reload:

```bash
source ~/.zshrc
```

**Optional — silence direnv output:** direnv prints a line whenever it loads or exports variables on `cd`. If you find this noisy, or if you use Powerlevel10k with instant prompt and see a warning about console output during zsh initialization, add this to `~/.config/direnv/direnv.toml`:

```toml
[global]
hide_env_diff = true
```

## 3. Global one-time setup

With PATH sorted, run these once per machine:

```bash
# Node 22 (repo is pinned to this via .nvmrc)
nvm install 22

# Git LFS global hooks
git lfs install

# Rust toolchain pinned by rust-toolchain.toml (or let the first cargo command trigger it)
rustup toolchain install 1.94.0

# Cargo tools
cargo install tauri-cli --version "^2" --locked
cargo install wasm-pack --version 0.15.0 --locked
```

## 4. Per-project setup

Clone and configure the repo:

```bash
git clone https://github.com/nteract/nteract.git
cd nteract
git lfs pull       # hydrate LFS-tracked bundles (required before building)
nvm use            # switches to Node 22 (reads .nvmrc)
direnv allow       # activate per-worktree env vars from .envrc
```

Enable pnpm via corepack (uses the version pinned in `package.json`):

```bash
corepack enable
corepack prepare pnpm@latest --activate
```

> `corepack enable` alone does not download pnpm. Running `corepack prepare` pre-downloads it so `cargo xtask` commands don't hang waiting for a download prompt.

## 5. First build

`cargo xtask dev` handles the full first-run sequence: installs pnpm
dependencies, runs `uv sync`, builds WASM artifacts and the MCP widget, compiles
Rust sidecars, and starts the dev daemon and Vite dev server. Python bindings
are no longer part of the default build (the MCP server is Rust-native). Agents
iterating on `runtimed-py` should use `cargo xtask integration` (which runs
`maturin develop`) or rebuild via the nteract-dev MCP (`up rebuild=true`).

```bash
cargo xtask dev
```

Subsequent launches skip slow steps:

```bash
cargo xtask dev --skip-install   # skip pnpm install if deps haven't changed
cargo xtask dev --skip-build     # reuse existing build artifacts
```

### Development app identity and recovery

Source-built macOS apps use a per-worktree wrapper in the development cache.
The wrapper has a resolvable identity such as `nteract Dev f0f9d9` with bundle
identifier `org.nteract.desktop.dev.f0f9d99b161f`; it does not replace stable or
Nightly and does not register notebook file associations. Release bundle names,
identifiers, signing, and packaging remain unchanged.

```bash
cargo xtask dev status  # exact PID, executable, app identity, Vite URL, and socket
cargo xtask dev focus   # activate that exact NSRunningApplication on macOS
cargo xtask dev reset   # stop only this worktree's app and daemon
```

For accessibility automation, copy the `Automation PID` from `dev status` and
target the System Events process whose `unix id` matches it. Do not address an
application by the generic name `nteract`; LaunchServices may resolve an installed
stable or Nightly bundle instead of the source-built process.

Vite handles ordinary frontend hot reload. If a Tauri bootstrap or listener has
survived in a stale state, restart both halves of the worktree-local development
session with:

```bash
cargo xtask dev --fresh
```

The command validates the recorded PID and executable before terminating the app,
clears stale process metadata, stops the daemon at this worktree's socket, and then
launches a clean daemon and desktop process. `direnv allow` remains recommended for
an interactive shell, but xtask also derives and exports the worktree namespace
explicitly.
