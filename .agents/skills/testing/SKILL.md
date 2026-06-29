---
name: testing
description: Run tests, verify changes, and collect diagnostics. Use when running tests, writing new tests, verifying code changes before commit, or collecting logs for debugging.
---

# Testing & Verification

## Quick Reference

| Type | Location | Command | Framework |
|------|----------|---------|-----------|
| Browser E2E | `apps/notebook/e2e/` | `pnpm --filter notebook-ui test:e2e:browser` | Playwright |
| Native E2E | `e2e/specs/` | `cargo xtask e2e test` | WebdriverIO + Mocha |
| Frontend unit | `src/**/__tests__/`, `apps/notebook/src/**/__tests__/` | `pnpm test` | Vitest + jsdom |
| Rust unit | inline `#[cfg(test)]` | `cargo test` | built-in |
| CLI behavior | `crates/runt/tests/*.hone` | `cargo hone test` | Hone |
| Python | `python/runtimed/tests/` | `pytest` | pytest |

## Verification Workflow

After making changes, run the narrowest credible test first, then broader checks.

### Narrow Tests by Crate

| Files changed | Test command |
|---|---|
| `crates/runtimed/src/**` | `cargo test -p runtimed` |
| `crates/notebook-wire/src/**` | `cargo test -p notebook-wire && cargo test -p notebook-protocol` |
| `crates/notebook-doc/src/**` | `cargo test -p notebook-doc` |
| `crates/notebook-protocol/src/**` | `cargo test -p notebook-protocol` |
| `crates/notebook-sync/src/**` | `cargo test -p notebook-sync` |
| `crates/kernel-env/src/**` | `cargo test -p kernel-env` |
| `crates/kernel-launch/src/**` | `cargo test -p kernel-launch` |
| `crates/runt/src/**` | `cargo test -p runt` |
| `crates/runt-workspace/src/**` | `cargo test -p runt-workspace` |
| `crates/runtimed-py/src/**` | `up rebuild=true` |
| `crates/runtimed-wasm/**` | `cargo xtask wasm` then `deno test --allow-read --allow-env --no-check` |
| `apps/notebook/src/**` | `pnpm test:run` |
| `python/runtimed/src/**` | `pytest python/runtimed/tests/test_session_unit.py -v` |

Multiple crates: `cargo test -p runtimed -p notebook-doc`.

### MCP Live Verification (when nteract-dev available)

For daemon/kernel changes: `up rebuild=true` → `create_notebook` → `create_cell` with `1 + 1` → `execute_cell` → verify output is `2`.

For CRDT/doc changes: `create_notebook` → `create_cell` → `get_cell` (verify source) → `set_cell` → `get_cell` (verify update).

For kernel-env changes: `up rebuild=true` → `create_notebook` → execute `import sys; print(sys.executable)` → verify Python path.

### Confidence Levels

- **HIGH**: Narrow tests passed AND MCP live verification passed
- **MEDIUM**: Narrow tests passed, MCP verification skipped
- **LOW**: Only compilation checked

Always run `cargo xtask lint --fix` before committing.

## Frontend Unit Tests (Vitest)

Config: `vitest.config.ts` (jsdom environment, globals enabled).

```bash
pnpm test         # Watch mode
pnpm test:run     # Run once
```

Key locations: `src/components/isolated/__tests__/`, `src/components/outputs/__tests__/`, `src/components/widgets/__tests__/`, `apps/notebook/src/lib/__tests__/`.

## Rust Unit Tests

```bash
cargo test                    # All workspace tests
cargo test -p runtimed        # Specific crate
cargo test -- --nocapture     # Show println! output
```

## Hone CLI Tests

Declarative bash-based tests in `crates/runt/tests/*.hone`.

```bash
cargo hone test               # All hone tests
cargo hone test cli.hone      # Specific file
```

Assertions: `ASSERT exit_code == 0`, `ASSERT stdout contains "text"`, `ASSERT stdout matches /pattern/`.

## Python Tests

Two venvs: workspace (`.venv` at root) for dev, and `python/runtimed/.venv` for isolated pytest.

```bash
# Setup test venv
cd python/runtimed && python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
cd ../../crates/runtimed-py && VIRTUAL_ENV=../../python/runtimed/.venv maturin develop

# Run
pytest python/runtimed/tests/test_session_unit.py -v          # Unit (no daemon)
SKIP_INTEGRATION_TESTS=1 pytest python/runtimed/tests/ -v     # Skip integration
RUNTIMED_INTEGRATION_TEST=1 pytest python/runtimed/tests/ -v  # CI mode (spawns daemon)
```

## Browser E2E Tests

Playwright tests in `apps/notebook/e2e/` are the preferred E2E surface for
notebook UI, runtime, fixture, and renderer behavior. They use the Vite browser
relay plus the dev daemon, avoiding the slower Tauri WebDriver app build.

```bash
pnpm --filter notebook-ui test:e2e:browser -- --project=chromium
pnpm --filter notebook-ui test:e2e:browser -- --project=chromium apps/notebook/e2e/execute-cell-output.spec.ts
pnpm --filter notebook-ui test:e2e:browser:portless -- --project=chromium
```

## Native E2E Tests

Native WebDriverIO tests should stay focused on Tauri-specific setup: app shell
boot, cwd-derived untitled notebook behavior, launcher/bootstrap behavior, and
other issues that require the real Tauri process.

### Running

```bash
cargo xtask e2e build       # Build with WebDriver support (required first)
cargo xtask e2e test        # Native smoke/default run
cargo xtask e2e test-all    # Native smoke plus long-tail Tauri fixtures
cargo xtask e2e test-fixture <notebook> <spec>  # Single fixture test
```

### Adding Tests

**Fixture test:** Create notebook in `crates/notebook/fixtures/audit-test/`, create spec in `e2e/specs/`, add to `FIXTURE_SPECS` in `e2e/wdio.conf.js`, add to `crates/xtask/src/main.rs`, add to CI.

**Regular test:** Create spec in `e2e/specs/` — picked up automatically if not in `FIXTURE_SPECS`.

### Helpers (e2e/helpers.js)

| Helper | Purpose |
|--------|---------|
| `waitForAppReady()` | Waits for toolbar (15s). Use in every `before()` hook |
| `waitForKernelReady()` | Waits for kernel idle/busy (60s). Superset of above |
| `executeFirstCell()` | Focuses first code cell, Shift+Enter |
| `waitForCellOutput(cell)` | Waits for stream output |
| `waitForOutputContaining(cell, text)` | Waits for specific output text |
| `approveTrustDialog()` | Clicks "Trust & Install" |
| `typeSlowly(text)` | Character-by-character (30ms). Required for CodeMirror |
| `setupCodeCell()` | Finds/creates code cell, focuses editor, selects all |

### wry WebDriver Constraints

- Use `data-testid` attributes — text selectors return broken refs
- Use `browser.execute()` + `browser.waitUntil()` — `executeAsync()` unsupported
- Use `typeSlowly()` for CodeMirror — fast input drops characters
- Use `browser.execute()` for iframe testing — `switchToFrame()` broken

### Selectors

`data-testid`: `notebook-toolbar`, `save-button`, `add-code-cell-button`, `add-markdown-cell-button`, `start-kernel-button`, `restart-kernel-button`, `interrupt-kernel-button`, `run-all-button`, `deps-toggle`, `trust-dialog`, `trust-approve-button`, `deps-panel`, `deps-add-input`.

`data-slot`: `output-area`, `ansi-stream-output`, `ansi-error-output`.

Other: `[data-cell-type="code"]`, `[data-cell-type="markdown"]`, `.cm-content[contenteditable="true"]`, `iframe[sandbox]`.

## Diagnostics

### Collecting

Use `env -i` for system diagnostics to avoid dev env vars (`RUNTIMED_DEV`, `RUNTIMED_WORKSPACE_PATH`) leaking through.

```bash
# Nightly (system)
env -i HOME=$HOME /usr/local/bin/runt-nightly diagnostics

# Stable (system)
env -i HOME=$HOME /usr/local/bin/runt diagnostics

# Dev daemon (no env -i needed)
RUNTIMED_DEV=1 RUNTIMED_WORKSPACE_PATH="$(pwd)" ./target/debug/runt diagnostics
```

Other system commands follow the same `env -i` pattern:
```bash
env -i HOME=$HOME /usr/local/bin/runt-nightly daemon status
env -i HOME=$HOME /usr/local/bin/runt-nightly daemon logs -f
env -i HOME=$HOME /usr/local/bin/runt ps
```

Read files from tarball without extracting:
```bash
tar xzf <archive>.tar.gz -O doctor.json
tar xzf <archive>.tar.gz -O runtimed.log | grep -i 'error\|panic'
```

### What to Look For

- **Ghost windows:** `Context for '...' missing` in notebook.log
- **Daemon crashes:** Check `runtimed.log.1` (previous session)
- **Upgrade failures:** Search `[upgrade]` in notebook.log
- **Kernel issues:** Search `[daemon-kernel]` or `kernel_status`
- **Sync errors:** Search `[notebook-sync]` or `daemon:disconnected`
- **Frontend errors:** `webview:error` or `webview:warn` in notebook.log
- **launchd issues:** Check `doctor.json` `launchd_service` status

## Test Philosophy

Prefer fast integration tests over slow E2E. Use E2E for critical user journeys, integration tests for daemon behavior, unit tests for algorithms.
