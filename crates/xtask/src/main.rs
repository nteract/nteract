// Allow `expect()` and `unwrap()` in tests
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]

use std::collections::{HashSet, VecDeque};
use std::env;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{exit, Child, Command, ExitStatus, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime};

mod bump;

/// Find the workspace root (nearest ancestor containing a Cargo.toml with
/// a `[workspace]` section). Subcommands that need repo-relative paths
/// can call `ensure_workspace_root_cwd()` from within the subcommand to
/// `cd` there before shelling out.
fn find_workspace_root() -> Option<PathBuf> {
    let mut dir = env::current_dir().ok()?;
    loop {
        let cargo = dir.join("Cargo.toml");
        if cargo.exists() {
            if let Ok(contents) = fs::read_to_string(&cargo) {
                if contents.contains("[workspace]") {
                    return Some(dir);
                }
            }
        }
        dir = dir.parent()?.to_path_buf();
    }
}

/// Change the process cwd to the workspace root. Scope this to the
/// specific subcommands that need it — not the top of `main` — because
/// several xtask subcommands accept user-supplied relative path arguments
/// (`notebook foo.ipynb`, `icons ./src.png`, `mcpb --output dist/out.mcpb`,
/// `e2e test-fixture fixture.ipynb spec.js`, `run notebook.ipynb`) and
/// those must stay relative to the shell cwd where the user invoked
/// `cargo xtask`. A global cd silently reinterprets those args against
/// the workspace root and opens/writes the wrong files.
pub(crate) fn ensure_workspace_root_cwd() {
    if let Some(root) = find_workspace_root() {
        let _ = env::set_current_dir(&root);
    }
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();

    if args.is_empty() {
        print_help();
        exit(0);
    }

    match args[0].as_str() {
        "dev" => {
            let options = parse_dev_options(&args);
            cmd_dev(options.notebook, options.skip_install, options.skip_build);
        }
        "notebook" => {
            let attach = args.iter().any(|a| a == "--attach");
            let notebook = args
                .iter()
                .skip(1)
                .find(|a| !a.starts_with('-'))
                .map(String::as_str);
            cmd_notebook(notebook, attach);
        }
        "vite" => cmd_vite(),
        "build" => {
            let rust_only = args.iter().any(|a| a == "--rust-only");
            let skip_tauri = args.iter().any(|a| a == "--skip-tauri");
            cmd_build(rust_only, skip_tauri);
        }
        "run" => {
            let notebook = args.get(1).map(String::as_str);
            cmd_run(notebook);
        }
        "icons" => {
            let source = args.get(1).map(String::as_str);
            cmd_icons(source);
        }
        "e2e" => {
            let sub_args: Vec<String> = args[1..].to_vec();
            cmd_e2e(sub_args);
        }
        "build-dmg" => cmd_build_dmg(),
        "build-app" => cmd_build_app(),
        "dev-daemon" => {
            let release = args.iter().any(|a| a == "--release");
            cmd_dev_daemon(release);
        }
        "run-mcp" | "mcp" => {
            let print_config = args.iter().any(|a| a == "--print-config");
            let release = args.iter().any(|a| a == "--release");
            cmd_mcp(print_config, release);
        }
        "pi" => {
            let pi_args: Vec<String> = if args.get(1).is_some_and(|arg| arg == "--") {
                args[2..].to_vec()
            } else {
                args[1..].to_vec()
            };
            cmd_pi(&pi_args);
        }
        "mcp-inspector" => cmd_mcp_inspector(),
        "lint" => {
            let fix = args.iter().any(|a| a == "--fix");
            cmd_lint(fix);
        }
        "clippy" => cmd_clippy(),
        "integration" => {
            let filter = args.iter().find(|a| !a.starts_with('-')).cloned();
            cmd_integration(filter);
        }
        "wasm" => {
            let skip_renderer_plugins = args.iter().any(|a| a == "--skip-renderer-plugins");
            let target = args
                .iter()
                .skip(1)
                .find(|a| !a.starts_with('-'))
                .map(|s| s.as_str());
            cmd_wasm(target, skip_renderer_plugins);
        }
        "artifacts" => {
            let command = parse_artifact_command(&args[1..]);
            cmd_artifacts(command);
        }
        "renderer-plugins" => {
            let only = parse_renderer_plugin_targets(&args[1..]);
            let only_refs: Vec<&str> = only.iter().map(String::as_str).collect();
            cmd_renderer_plugins(&only_refs);
        }
        "verify-plugins" => cmd_verify_plugins(),
        "verify-genesis" => cmd_verify_genesis(),
        "wasm-ensure" | "wasm-ensure-runtime" => cmd_wasm_ensure_runtime(),
        "wasm-verify" => cmd_wasm_verify(),
        "mcpb" => {
            let output = args
                .windows(2)
                .find(|w| w[0] == "--output")
                .map(|w| w[1].as_str());
            let variant = args
                .windows(2)
                .find(|w| w[0] == "--variant")
                .map(|w| w[1].as_str())
                .unwrap_or("stable");
            cmd_mcpb(output, variant);
        }
        "sync-tool-cache" => {
            let check = args.iter().any(|a| a == "--check");
            cmd_sync_tool_cache(check);
        }
        "check-dep-budget" => cmd_check_dep_budget(),
        "bump" => {
            let level = args.get(1).map(String::as_str).unwrap_or("patch");
            bump::cmd_bump(level);
        }
        "--help" | "-h" | "help" => print_help(),
        cmd => {
            eprintln!("Unknown command: {cmd}");
            eprintln!();
            print_help();
            exit(1);
        }
    }
}

fn print_help() {
    eprintln!(
        "Usage: cargo xtask <COMMAND>

Development:
  dev [notebook.ipynb]         Setup once, start dev daemon + notebook app
  dev --skip-build             Reuse existing build artifacts before launch
  dev --skip-install           Reuse existing pnpm install before launch
  notebook [notebook.ipynb]    Start hot-reload dev server (dev mode, safe)
  notebook --attach [notebook] Attach Tauri to existing Vite server
  vite                       Start Vite server standalone
  build                      Full debug build (frontend + rust)
  build --rust-only          Rebuild rust only, reuse existing frontend
  build --rust-only --skip-tauri
                             Rebuild Rust sidecars only, skipping the Tauri app link
  run [notebook.ipynb]       Run bundled debug binary

Release:
  build-app                  Build .app bundle with icons
  build-dmg                  Build DMG with icons (for CI)

Daemon:
  dev-daemon [--release]     Build and run runtimed in per-worktree dev mode
                             (for local nightly install on Linux see ./scripts/install-nightly)

MCP:
  run-mcp [--release]        Build and run the nteract-dev MCP supervisor (proxy + daemon + auto-restart)
  run-mcp --print-config     Print MCP client config JSON (for Zed, Claude, etc.)
  mcp-inspector              Launch MCPJam Inspector UI to test runt mcp (MCP Apps)
  pi [args...]               Build local @runtimed/node assets and run Pi with the nteract extension

Linting:
  lint                       Check formatting and linting (Rust fmt, JS/TS, Python)
  lint --fix                 Auto-fix formatting and linting issues
  clippy                     Run cargo clippy (excludes runtimed-py; CI covers it)

Testing:
  integration [filter]       Run Python integration tests with an isolated daemon
                             Optional filter is passed to pytest -k (e.g. 'test_start_kernel')
  e2e [build|test|test-fixture|test-all]
                             E2E testing (build, run, manage fixtures)

Other:
  wasm                       Rebuild all WASM targets (runtimed-wasm + sift-wasm).
                             If sift-wasm was (re)built, also rebuilds the sift
                             renderer plugin so it re-embeds fresh wasm-bindgen glue.
  wasm runtimed              Rebuild only runtimed-wasm
  wasm sift                  Rebuild only sift-wasm (bindings for @nteract/sift);
                             also rebuilds the sift renderer plugin.
  wasm --skip-renderer-plugins
                             Skip the chained renderer-plugins rebuild (escape hatch
                             for intentionally testing drift between the two).
  artifacts status [scopes]  Report generated artifact readiness without rebuilding.
  artifacts ensure [scopes]  Rebuild missing or stale generated artifacts.
  artifacts verify [scopes]  Strictly verify generated artifacts; exits non-zero
                             when anything is missing, stale, or lacks fingerprints.
                             Scopes: runtime, sift, renderer, mcp-widget, all.
  renderer-plugins           Rebuild pre-built renderer plugins
  renderer-plugins --only sift
                             Rebuild one renderer plugin target. Valid targets:
                             isolated-renderer, core, markdown, plotly, bokeh,
                             panel, vega, leaflet, sift.
  verify-plugins             Check renderer plugin bundles match their wasm artifacts
                             (every wasm-bindgen import in the plugin JS must be
                             exported by the paired wasm binary). Catches #2048-style
                             drift without requiring cross-platform byte reproducibility.
  verify-genesis             Check the built runtimed-wasm embeds the current Automerge
                             genesis seeds, so the frontend and daemon share a root.
                             Catches a stale wasm after a schema/seed bump (#3086).
  wasm-ensure-runtime        Ensure runtimed-wasm outputs match source fingerprints
                             and genesis seeds, rebuilding when stale or missing.
  wasm-ensure                Alias for wasm-ensure-runtime.
  wasm-verify                Verify downloaded WASM artifacts and fingerprints
                             without rebuilding them.
  icons [source.png]         Generate icon variants
  mcpb                       Package nteract as a Claude Desktop extension (.mcpb)
  mcpb --variant nightly     Build nightly variant (different name/icon)
  mcpb --output <path>       Write the .mcpb archive to a custom path
  sync-tool-cache            Regenerate tool-cache.json + MCPB manifests from runt binary
  sync-tool-cache --check    Check caches are up to date + description byte budget (for CI)
  check-dep-budget           Check transitive dependency counts against per-crate budgets
  bump [patch|minor|major]   Bump every versioned artifact (crates, Tauri app,
                             Python, frontend packages, plugin manifests) in
                             lockstep and regenerate Cargo.lock. Defaults to patch.
  help                       Show this help
"
    );
}

/// Run Python integration tests with a fresh isolated daemon.
///
/// Builds the daemon binary, spawns it in a temp directory with its own
/// worktree hash (no singleton conflicts), and runs pytest against it.
/// The daemon is cleaned up when tests finish.
fn cmd_integration(filter: Option<String>) {
    // runtimed embeds gitignored renderer-plugin artifacts; make this xtask
    // entry point self-healing in fresh Codex/worktree sessions.
    ensure_build_artifacts();

    // 1. Build the daemon
    println!("Building runtimed for integration tests...");
    let status = Command::new("cargo")
        .args(["build", "-p", "runtimed"])
        .status();
    if !status.map(|s| s.success()).unwrap_or(false) {
        eprintln!("Failed to build runtimed");
        exit(1);
    }

    // 2. Ensure Python env is ready
    ensure_python_env();
    ensure_maturin_develop();

    // 3. Create an isolated workspace path so the daemon gets its own
    //    worktree hash and doesn't conflict with the dev daemon.
    let workspace_dir =
        std::env::temp_dir().join(format!("runtimed-integration-{}", std::process::id()));
    std::fs::create_dir_all(&workspace_dir).unwrap_or_else(|e| {
        eprintln!("Failed to create temp workspace: {e}");
        exit(1);
    });

    // 4. Build pytest args
    let binary_path = cargo_debug_binary_path("runtimed");
    let binary = std::fs::canonicalize(&binary_path).unwrap_or_else(|e| {
        eprintln!(
            "Failed to resolve runtimed binary at {}: {e}",
            binary_path.display()
        );
        exit(1);
    });

    // dx integration tests are NOT run here — they require the real repo
    // pyproject.toml (kernels use `env_source="uv:pyproject"` to install dx
    // and pandas), but `cmd_integration` deliberately uses a TEMP
    // RUNTIMED_WORKSPACE_PATH for isolation. dx integration is gated by
    // the CI workflow `build.yml` instead, which runs from
    // `${GITHUB_WORKSPACE}` (the real repo root).
    let mut pytest_args = vec![
        "run".to_string(),
        "pytest".to_string(),
        "python/runtimed/tests/test_daemon_integration.py".to_string(),
        "-v".to_string(),
        "--timeout=120".to_string(),
        "--tb=short".to_string(),
        "--durations=15".to_string(),
    ];
    if let Some(ref f) = filter {
        pytest_args.push("-k".to_string());
        pytest_args.push(f.clone());
    }

    println!("Running integration tests...");
    println!("  Daemon binary: {}", binary.display());
    println!("  Workspace: {}", workspace_dir.display());
    if let Some(ref f) = filter {
        println!("  Filter: {f}");
    }
    println!();

    // 5. Run pytest with CI mode env vars
    let status = Command::new("uv")
        .args(&pytest_args)
        .env("RUNTIMED_INTEGRATION_TEST", "1")
        .env("RUNTIMED_BINARY", &binary)
        .env("RUNTIMED_WORKSPACE_PATH", &workspace_dir)
        .env("RUNTIMED_LOG_LEVEL", "info")
        .status();

    // 6. Cleanup temp workspace
    let _ = std::fs::remove_dir_all(&workspace_dir);

    match status {
        Ok(s) if s.success() => {
            println!("\nAll integration tests passed!");
        }
        Ok(s) => {
            eprintln!("\nSome integration tests failed.");
            exit(s.code().unwrap_or(1));
        }
        Err(e) => {
            eprintln!("Failed to run pytest: {e}");
            exit(1);
        }
    }
}

/// Check that an external tool is available in PATH, exit with install instructions if not.
fn require_tool(name: &str, install_hint: &str) {
    let ok = Command::new(name)
        .arg("--version")
        .stdin(Stdio::null()) // prevent interactive mode from hanging waiting for user input
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if !ok {
        eprintln!("Error: `{name}` is required but was not found in PATH.");
        eprintln!();
        eprintln!("  Install:  {install_hint}");
        exit(1);
    }
}

/// Check that a cargo subcommand (e.g. `cargo tauri`) is available.
fn require_cargo_subcommand(name: &str, install_hint: &str) {
    let ok = Command::new("cargo")
        .args([name, "--version"])
        .stdin(Stdio::null()) // prevent interactive mode from hanging waiting for user input
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if !ok {
        eprintln!("Error: `cargo {name}` is required but was not found.");
        eprintln!();
        eprintln!("  Install:  {install_hint}");
        exit(1);
    }
}

const PNPM_INSTALL: &str = "corepack enable  (or install the pnpm version pinned in package.json)";
const TAURI_INSTALL: &str = "cargo install tauri-cli";
const WASM_PACK_INSTALL: &str = "cargo install wasm-pack --version 0.15.0 --locked";

fn require_pnpm() -> PnpmCommand {
    let pnpm = resolve_pnpm_command_or_exit();
    println!("Using pnpm {} via {}", pnpm.version, pnpm.display_name());
    pnpm
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PnpmSource {
    Corepack,
    Direct,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PnpmCommand {
    source: PnpmSource,
    version: String,
}

impl PnpmCommand {
    fn command(&self) -> Command {
        let mut command = Command::new(self.program());
        command.args(self.prefix_args());
        if self.source == PnpmSource::Corepack {
            command.env("COREPACK_ENABLE_DOWNLOAD_PROMPT", "0");
        }
        command
    }

    fn program(&self) -> &'static str {
        match self.source {
            PnpmSource::Corepack => corepack_bin(),
            PnpmSource::Direct => pnpm_bin(),
        }
    }

    fn prefix_args(&self) -> &'static [&'static str] {
        match self.source {
            PnpmSource::Corepack => &["pnpm"],
            PnpmSource::Direct => &[],
        }
    }

    fn display_name(&self) -> &'static str {
        match self.source {
            PnpmSource::Corepack => "corepack pnpm",
            PnpmSource::Direct => "pnpm",
        }
    }

    fn display_with_args(&self, args: &[&str]) -> String {
        let mut parts = Vec::with_capacity(1 + args.len());
        parts.push(self.display_name().to_string());
        parts.extend(args.iter().map(|arg| (*arg).to_string()));
        parts.join(" ")
    }
}

fn resolve_pnpm_command_or_exit() -> PnpmCommand {
    let expected = expected_pnpm_version_or_exit();
    let root = workspace_root_or_exit();

    let corepack_version = probe_pnpm_version(corepack_bin(), &["pnpm"], &root);
    if version_matches(&corepack_version, &expected) {
        return PnpmCommand {
            source: PnpmSource::Corepack,
            version: expected,
        };
    }

    let direct_version = probe_pnpm_version(pnpm_bin(), &[], &root);

    match choose_pnpm_source(&expected, &corepack_version, &direct_version) {
        Some(PnpmSource::Corepack) => PnpmCommand {
            source: PnpmSource::Corepack,
            version: expected,
        },
        Some(PnpmSource::Direct) => PnpmCommand {
            source: PnpmSource::Direct,
            version: expected,
        },
        None => {
            eprintln!(
                "Error: package.json pins `pnpm@{expected}`, but xtask could not resolve that pnpm version."
            );
            eprintln!(
                "  corepack pnpm --version: {}",
                describe_pnpm_probe(&corepack_version)
            );
            eprintln!(
                "  {} --version: {}",
                pnpm_bin(),
                describe_pnpm_probe(&direct_version)
            );
            eprintln!();
            eprintln!("  Install:  {PNPM_INSTALL}");
            eprintln!("  Or put a pnpm {expected} shim before other pnpm binaries in PATH.");
            eprintln!();
            eprintln!(
                "Refusing to run a mismatched ambient pnpm because it may reinstall node_modules."
            );
            exit(1);
        }
    }
}

fn choose_pnpm_source(
    expected: &str,
    corepack_version: &Result<String, String>,
    direct_version: &Result<String, String>,
) -> Option<PnpmSource> {
    if version_matches(corepack_version, expected) {
        Some(PnpmSource::Corepack)
    } else if version_matches(direct_version, expected) {
        Some(PnpmSource::Direct)
    } else {
        None
    }
}

fn version_matches(version: &Result<String, String>, expected: &str) -> bool {
    matches!(version, Ok(actual) if actual == expected)
}

fn expected_pnpm_version_or_exit() -> String {
    expected_pnpm_version().unwrap_or_else(|error| {
        eprintln!("Error: {error}");
        exit(1);
    })
}

fn expected_pnpm_version() -> Result<String, String> {
    let root = workspace_root_or_exit();
    let package_json = root.join("package.json");
    let contents = fs::read_to_string(&package_json)
        .map_err(|error| format!("failed to read {}: {error}", package_json.display()))?;
    let manifest: serde_json::Value = serde_json::from_str(&contents)
        .map_err(|error| format!("failed to parse {}: {error}", package_json.display()))?;
    let package_manager = manifest
        .get("packageManager")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| format!("{} is missing `packageManager`", package_json.display()))?;

    parse_pnpm_package_manager_version(package_manager).map(str::to_string)
}

fn parse_pnpm_package_manager_version(package_manager: &str) -> Result<&str, String> {
    let version = package_manager.strip_prefix("pnpm@").ok_or_else(|| {
        format!("`packageManager` must be a pnpm spec like `pnpm@10.30.0`, got `{package_manager}`")
    })?;
    let version = version.split('+').next().unwrap_or(version);
    if version.is_empty() {
        Err("`packageManager` must include a pnpm version".to_string())
    } else {
        Ok(version)
    }
}

fn probe_pnpm_version(program: &str, prefix_args: &[&str], root: &Path) -> Result<String, String> {
    let mut command = Command::new(program);
    command
        .args(prefix_args)
        .arg("--version")
        .current_dir(root)
        .stdin(Stdio::null())
        .env("COREPACK_ENABLE_DOWNLOAD_PROMPT", "0");

    let output = command
        .output()
        .map_err(|error| format!("failed to start: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "exited with status {}{}",
            output.status,
            command_output_summary(&output.stdout, &output.stderr)
        ));
    }

    last_non_empty_line(&output.stdout)
        .or_else(|| last_non_empty_line(&output.stderr))
        .ok_or_else(|| "succeeded but printed no version".to_string())
}

fn last_non_empty_line(bytes: &[u8]) -> Option<String> {
    String::from_utf8_lossy(bytes)
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_string)
}

fn command_output_summary(stdout: &[u8], stderr: &[u8]) -> String {
    let mut lines = Vec::new();
    if let Some(line) = last_non_empty_line(stdout) {
        lines.push(line);
    }
    if let Some(line) = last_non_empty_line(stderr) {
        lines.push(line);
    }
    if lines.is_empty() {
        String::new()
    } else {
        format!(" ({})", lines.join("; "))
    }
}

fn describe_pnpm_probe(result: &Result<String, String>) -> String {
    match result {
        Ok(version) => format!("reported pnpm {version}"),
        Err(error) => error.clone(),
    }
}

fn run_pnpm(args: &[&str]) {
    let pnpm = resolve_pnpm_command_or_exit();
    let mut command = pnpm.command();
    command.args(args);

    let status = command.status().unwrap_or_else(|error| {
        eprintln!("Failed to run {}: {error}", pnpm.display_name());
        exit(1);
    });

    if !status.success() {
        eprintln!("Command failed: {}", pnpm.display_with_args(args));
        exit(status.code().unwrap_or(1));
    }
}

fn run_pnpm_ok(args: &[&str]) -> bool {
    let pnpm = resolve_pnpm_command_or_exit();
    let mut command = pnpm.command();
    command.args(args);

    command.status().map(|s| s.success()).unwrap_or_else(|e| {
        eprintln!("Failed to run {}: {e}", pnpm.display_name());
        false
    })
}

/// Name to invoke pnpm under for `Command::new`.
///
/// On Windows, `pnpm/action-setup@v4` (and corepack) install pnpm as a
/// `pnpm.cmd` shim wrapping node. There is no `pnpm.exe`. Rust's
/// `Command::new("pnpm")` calls `CreateProcess` directly, which does not
/// apply `PATHEXT` resolution, so it fails with "not found in PATH" even
/// when `pnpm.cmd` is on `PATH` and `pnpm install` works fine from the
/// surrounding bash/pwsh shell. Always invoke `pnpm.cmd` on Windows.
fn pnpm_bin() -> &'static str {
    if cfg!(windows) {
        "pnpm.cmd"
    } else {
        "pnpm"
    }
}

/// Name to invoke Corepack under for `Command::new`.
///
/// Corepack is also installed as a `.cmd` shim on Windows, so use the same
/// explicit extension pattern as pnpm to avoid relying on PATHEXT expansion.
fn corepack_bin() -> &'static str {
    if cfg!(windows) {
        "corepack.cmd"
    } else {
        "corepack"
    }
}

fn require_tauri() {
    require_cargo_subcommand("tauri", TAURI_INSTALL);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct DevOptions<'a> {
    notebook: Option<&'a str>,
    skip_install: bool,
    skip_build: bool,
}

fn parse_dev_options(args: &[String]) -> DevOptions<'_> {
    DevOptions {
        notebook: args
            .iter()
            .skip(1)
            .find(|arg| !arg.starts_with('-'))
            .map(String::as_str),
        skip_install: args.iter().any(|arg| arg == "--skip-install"),
        skip_build: args.iter().any(|arg| arg == "--skip-build"),
    }
}

fn cmd_dev(notebook: Option<&str>, skip_install: bool, skip_build: bool) {
    require_pnpm();
    require_tauri();

    if skip_install {
        println!("Skipping pnpm install (--skip-install)");
    } else {
        ensure_pnpm_install();
        ensure_python_env();
    }

    // `cargo tauri dev` boots its own Vite dev server and recompiles the
    // notebook crate fresh, so the Phase 2 production bundle and Phase 3
    // tauri build that `cargo xtask build` runs would be ~40s of warm work
    // whose output the dev path immediately discards. Skip both. We still
    // need:
    //   - the gitignored wasm + renderer-plugin outputs (Vite imports
    //     them as virtual modules)
    //   - the MCP widget HTML (`runt-mcp` `include_str!`s `_output.html`)
    //   - the runtimed/runt/nteract-mcp sidecars when the dev daemon
    //     spawn falls through below
    ensure_build_artifacts();
    if skip_build {
        println!("Skipping sidecar build (--skip-build)");
    } else {
        build_mcp_widget();
    }

    println!();
    let mut daemon = None;
    if dev_daemon_running() {
        println!("Reusing existing development daemon for this worktree.");
    } else {
        println!("Starting development daemon for one-shot notebook workflow...");
        let mut child = spawn_dev_daemon_process(false);
        if let Err(error) = wait_for_dev_daemon(&mut child, Duration::from_secs(30)) {
            stop_child(&mut child, "development daemon");
            eprintln!("{error}");
            exit(1);
        }
        println!("Development daemon is ready.");
        daemon = Some(child);
    }
    println!();

    let status = run_notebook_dev_app(notebook, false, true);
    if let Some(ref mut child) = daemon {
        stop_child(child, "development daemon");
    }
    exit_on_failed_status("cargo tauri dev", status);
}

fn cmd_notebook(notebook: Option<&str>, attach: bool) {
    require_pnpm();
    require_tauri();

    // In --attach mode Tauri points at an already-running Vite dev server.
    // That Vite process owns the renderer-plugin virtual modules and the
    // runtimed-wasm bindings; our rebuilds here would just duplicate work
    // it's already watching for. Skip the force-rebuild cost in that case.
    // Without --attach, Tauri boots its own Vite, and we still need fresh
    // artifacts before the TS compile fires.
    if !attach {
        ensure_build_artifacts();
    }

    // Always use dev mode to prevent the Tauri app from auto-installing
    // the dev binary as the system daemon sidecar — that would clobber
    // any running nightly/release daemon and disconnect all open notebooks.
    //
    // In dev mode, ensure_daemon_via_sidecar() skips auto-install and
    // tells the user to run `cargo xtask dev-daemon` instead.
    if !dev_daemon_running() {
        eprintln!("⚠️  No dev daemon detected for this worktree.");
        eprintln!("   Start one first:  cargo xtask dev-daemon");
        eprintln!("   Or use the full workflow:  cargo xtask dev");
        eprintln!();
        eprintln!("   Running without a dev daemon will connect to the system daemon,");
        eprintln!("   which may disrupt other notebooks. Proceeding in dev mode anyway...");
        eprintln!();
    }
    ensure_pnpm_install();
    let status = run_notebook_dev_app(notebook, attach, true);
    exit_on_failed_status("cargo tauri dev", status);
}

fn run_notebook_dev_app(notebook: Option<&str>, attach: bool, force_dev_mode: bool) -> ExitStatus {
    // Delete bundled marker since we're building a dev binary
    let marker = notebook_bundled_marker_path();
    let _ = fs::remove_file(marker);

    let vite_port = resolve_vite_port(force_dev_mode);
    let mut command = Command::new("cargo");

    if attach {
        println!("Attaching to existing Vite server...");
        let port = vite_port.clone().unwrap_or_else(|| "5174".to_string());
        println!("Connecting to Vite at http://localhost:{port}");

        // Skip beforeDevCommand (Vite is already running), set devUrl,
        // and drop externalBin so sidecar binaries aren't required in dev
        let config = format!(
            r#"{{"build":{{"devUrl":"http://localhost:{port}","beforeDevCommand":""}},"bundle":{{"externalBin":[]}}}}"#
        );

        let mut args = vec!["tauri", "dev", "--config", &config, "--", "-p", "notebook"];
        if let Some(path) = notebook {
            args.extend(["--", path]);
        }

        command.args(&args);
    } else {
        println!("Starting dev server with hot reload...");

        // Always override externalBin so sidecar binaries aren't required
        // in dev mode (the daemon is started separately via dev-daemon)
        let config_override = match vite_port.as_ref() {
            Some(port) => {
                println!("Using RUNTIMED_VITE_PORT={port}");
                format!(
                    r#"{{"build":{{"devUrl":"http://localhost:{port}"}},"bundle":{{"externalBin":[]}}}}"#
                )
            }
            None => r#"{"bundle":{"externalBin":[]}}"#.to_string(),
        };

        let mut args = vec!["tauri", "dev", "--config", &config_override];
        args.extend(["--", "-p", "notebook"]);
        if let Some(path) = notebook {
            args.extend(["--", path]);
        }

        command.args(&args);
    }

    apply_rust_log_env(&mut command);
    apply_build_channel_env(&mut command);
    apply_worktree_env(&mut command, force_dev_mode);
    if let Some(ref port) = vite_port {
        command.env("RUNTIMED_VITE_PORT", port);
    }

    command.status().unwrap_or_else(|e| {
        eprintln!("Failed to run cargo tauri dev: {e}");
        exit(1);
    })
}

fn cmd_vite() {
    let pnpm = require_pnpm();

    println!("Starting Vite dev server...");
    println!("This server will keep running independently of Tauri.");
    println!("Use `cargo xtask notebook --attach` in another terminal to connect.");
    println!();

    let vite_port = resolve_vite_port(true);
    if let Some(ref port) = vite_port {
        println!("Using RUNTIMED_VITE_PORT={port}");
    }

    let args = ["--filter", "notebook-ui", "dev"];
    let mut command = pnpm.command();
    command.args(args);
    apply_worktree_env(&mut command, true);
    if let Some(ref port) = vite_port {
        command.env("RUNTIMED_VITE_PORT", port);
    }

    let status = command.status().unwrap_or_else(|e| {
        eprintln!("Failed to run {}: {e}", pnpm.display_with_args(&args));
        exit(1);
    });
    let label = pnpm.display_with_args(&args);
    exit_on_failed_status(&label, status);
}

fn ensure_pnpm_install() {
    if let Some(reason) = pnpm_install_reason() {
        println!("Running pnpm install ({reason})...");
        run_pnpm(&["install"]);
    } else {
        println!("Skipping pnpm install (node_modules is up to date).");
    }
}

fn pnpm_install_reason() -> Option<&'static str> {
    let install_marker = Path::new("node_modules/.modules.yaml");
    if !install_marker.exists() {
        return Some("missing node_modules metadata");
    }

    for link in [Path::new("packages/sift/node_modules/@chenglou/pretext")] {
        if !link.exists() {
            return Some("workspace package links missing");
        }
    }

    let Some(install_time) = modified_time(install_marker) else {
        return Some("could not read node_modules metadata timestamp");
    };
    for manifest in [
        Path::new("package.json"),
        Path::new("pnpm-lock.yaml"),
        Path::new("pnpm-workspace.yaml"),
        Path::new("apps/mcp-app/package.json"),
        Path::new("apps/notebook/package.json"),
        Path::new("apps/renderer-test/package.json"),
        Path::new("packages/notebook-host/package.json"),
        Path::new("packages/runtimed-node/package.json"),
        Path::new("packages/runtimed/package.json"),
        Path::new("packages/sift/package.json"),
        Path::new("plugins/nteract/pi/package.json"),
    ] {
        let Some(manifest_time) = modified_time(manifest) else {
            return Some("could not read package manifest timestamps");
        };
        if manifest_time > install_time {
            return Some("package manifests changed");
        }
    }

    None
}

fn modified_time(path: &Path) -> Option<std::time::SystemTime> {
    fs::metadata(path).ok()?.modified().ok()
}

const PYTHON_SYNC_STAMP: &str = "target/uv/.sync-stamp";

/// Ensure the Python workspace venv is synced (`uv sync`).
///
/// This installs all workspace members (nteract, runtimed) and their
/// dependencies (mcp, pydantic, etc.) into `.venv`. Needed for:
/// - `maturin develop` (installs into this venv)
/// - `uv run --no-sync` (expects deps to be present)
/// - Editor type-checking / LSP (needs the venv to resolve imports)
fn ensure_python_env() {
    if !Path::new("pyproject.toml").exists() {
        return;
    }
    if Command::new("uv").arg("--version").output().is_err() {
        println!("Skipping Python env sync (uv not found).");
        return;
    }

    if let Some(reason) = python_sync_reason() {
        println!("Syncing Python workspace ({reason})...");
        let status = Command::new("uv").args(["sync"]).status();
        match status {
            Ok(s) if s.success() => {
                let stamp = Path::new(PYTHON_SYNC_STAMP);
                if let Some(parent) = stamp.parent() {
                    if let Err(e) = fs::create_dir_all(parent).and_then(|_| fs::write(stamp, "")) {
                        eprintln!("Warning: failed to write Python sync stamp: {e}");
                    }
                }
            }
            Ok(s) => {
                eprintln!("Warning: uv sync failed (exit {})", s.code().unwrap_or(-1));
            }
            Err(e) => {
                eprintln!("Warning: failed to run uv sync: {e}");
            }
        }
    } else {
        println!("Skipping Python env sync (venv is up to date).");
    }
}

fn python_sync_reason() -> Option<&'static str> {
    let venv_marker = Path::new(".venv/pyvenv.cfg");
    if !venv_marker.exists() {
        return Some("missing .venv");
    }

    let Some(sync_time) = modified_time(Path::new(PYTHON_SYNC_STAMP)) else {
        return Some("missing Python sync stamp");
    };

    for manifest in [
        Path::new("uv.lock"),
        Path::new("pyproject.toml"),
        Path::new("python/nteract/pyproject.toml"),
        Path::new("python/runtimed/pyproject.toml"),
        venv_marker,
    ] {
        if let Some(manifest_time) = modified_time(manifest) {
            if manifest_time > sync_time {
                return Some("pyproject.toml or uv.lock changed");
            }
        } else {
            return Some("could not read Python env timestamps");
        }
    }

    None
}

const MATURIN_DEVELOP_STAMP: &str = "target/maturin/.develop-stamp";

fn maturin_develop_reason() -> Option<&'static str> {
    let stamp_time = modified_time(Path::new(MATURIN_DEVELOP_STAMP));
    let watched_times = [
        latest_modified_time_under(Path::new("Cargo.lock")),
        latest_modified_time_under(Path::new("crates/runtimed-py/Cargo.toml")),
        latest_modified_time_under(Path::new("crates/runtimed-py/src")),
        latest_modified_time_under(Path::new("crates/runtimed/Cargo.toml")),
        latest_modified_time_under(Path::new("crates/runtimed/src")),
        latest_modified_time_under(Path::new("crates/runtimed-client/Cargo.toml")),
        latest_modified_time_under(Path::new("crates/runtimed-client/src")),
        latest_modified_time_under(Path::new("python/runtimed/pyproject.toml")),
        latest_modified_time_under(Path::new("pyproject.toml")),
        latest_modified_time_under(Path::new(".venv/pyvenv.cfg")),
    ];
    freshness_reason(stamp_time, watched_times)
}

fn freshness_reason<I>(stamp_time: Option<SystemTime>, watched_times: I) -> Option<&'static str>
where
    I: IntoIterator<Item = Option<SystemTime>>,
{
    let Some(stamp_time) = stamp_time else {
        return Some("missing develop stamp");
    };

    for watched_time in watched_times {
        let Some(watched_time) = watched_time else {
            return Some("could not read binding source timestamps");
        };
        if watched_time > stamp_time {
            return Some("binding sources changed");
        }
    }

    None
}

fn latest_modified_time_under(path: &Path) -> Option<SystemTime> {
    let metadata = fs::metadata(path).ok()?;
    let mut latest = metadata.modified().ok()?;

    if metadata.is_dir() {
        for entry in fs::read_dir(path).ok()? {
            let entry = entry.ok()?;
            let entry_latest = latest_modified_time_under(&entry.path())?;
            latest = latest.max(entry_latest);
        }
    }

    Some(latest)
}

/// Ensure `maturin develop` has been run so the native `runtimed` extension
/// is installed into `.venv`.
///
/// Unlike `uv sync` (which builds a release wheel), `maturin develop` builds
/// a debug `.so` and symlinks it — faster to compile and always reflects the
/// latest Rust source.
fn ensure_maturin_develop() {
    if !Path::new("pyproject.toml").exists() {
        return;
    }
    if Command::new("uv").arg("--version").output().is_err() {
        println!("Skipping maturin develop (uv not found).");
        return;
    }

    let Some(reason) = maturin_develop_reason() else {
        println!("Skipping maturin develop (bindings are up to date).");
        return;
    };

    println!("Building runtimed Python bindings (maturin develop, {reason})...");
    // Resolve absolute path — maturin warns on relative VIRTUAL_ENV.
    // cargo xtask always runs from the workspace root (all paths in this
    // file are relative to it), so current_dir() is the repo root.
    let Ok(cwd) = std::env::current_dir() else {
        eprintln!("Warning: failed to get current directory for maturin develop");
        return;
    };
    // Use a separate target directory so maturin's cdylib build doesn't
    // invalidate fingerprints in the main target/ dir. Without this,
    // cargo tauri build (Phase 3) sees stale timestamps from maturin's
    // concurrent writes and recompiles the entire dependency tree.
    let maturin_target = cwd.join("target/maturin");
    let status = Command::new("uv")
        .args([
            "run",
            "--active",
            "--directory",
            "python/runtimed",
            "maturin",
            "develop",
            "--target-dir",
            &maturin_target.to_string_lossy(),
        ])
        .env("VIRTUAL_ENV", cwd.join(".venv"))
        .env_remove("CONDA_PREFIX")
        .status();

    match status {
        Ok(s) if s.success() => {
            let stamp = maturin_target.join(".develop-stamp");
            if let Err(e) = fs::create_dir_all(&maturin_target).and_then(|_| fs::write(&stamp, ""))
            {
                eprintln!("Warning: failed to write maturin develop stamp: {e}");
            }
        }
        Ok(s) => {
            eprintln!(
                "Warning: maturin develop failed (exit {})",
                s.code().unwrap_or(-1)
            );
        }
        Err(e) => {
            eprintln!("Warning: failed to run maturin develop: {e}");
        }
    }
}

fn cmd_build(rust_only: bool, skip_tauri: bool) {
    if !skip_tauri {
        require_tauri();
    }
    if !rust_only {
        require_pnpm();
    }

    // Phase 0: Ensure the gitignored wasm + renderer-plugin outputs exist.
    // `runtimed`'s build.rs `include_bytes!`-embeds them; the frontend
    // virtual modules need them too. On a fresh clone or stale workspace this
    // triggers the needed rebuilds; on warm trees it is a fingerprint check.
    ensure_build_artifacts();

    // Phase 0a: Install workspace pnpm deps up front. This was previously
    // kicked off as a background thread alongside cargo build. Keep it
    // centralized at the workspace root so build steps use the same install
    // state instead of materializing package-local dependencies ad hoc.
    if !rust_only {
        ensure_pnpm_install();
    }

    // Phase 0b: Build the MCP widget HTML before any Rust compilation.
    // runt-mcp uses include_str!("../assets/_output.html") which fails
    // if the asset doesn't exist yet. This must run before cargo build.
    if !rust_only {
        build_mcp_widget();
    } else {
        // Even in --rust-only mode, ensure the asset exists
        let widget_asset = Path::new("crates/runt-mcp/assets/_output.html");
        if !widget_asset.exists() {
            eprintln!("MCP widget asset missing — building it first...");
            build_mcp_widget();
        }
    }

    // Phase 1: Build all Rust crates except `notebook`.
    // The `notebook` crate's build.rs declares `rerun-if-changed` on
    // `apps/notebook/dist`, so building it here would be wasted work —
    // Phase 2 rebuilds the frontend (updating dist/), which invalidates
    // notebook's fingerprint and forces cargo tauri build to recompile it
    // anyway. By excluding notebook here, we still pre-warm the entire
    // dependency tree (all shared crates are built via the other targets),
    // and Phase 3 only needs to compile notebook + link.
    println!("Building Rust targets (runtimed, runt, nteract-mcp, mcp-supervisor)...");
    run_cmd(
        "cargo",
        &[
            "build",
            "-p",
            "runtimed",
            "-p",
            "runt",
            "-p",
            "nteract-mcp",
            "-p",
            "mcp-supervisor",
        ],
    );

    // Copy sidecar binaries for Tauri bundling
    copy_sidecar_binary("runtimed", false);
    copy_sidecar_binary("runt", false);
    copy_sidecar_binary("nteract-mcp", false);

    // Phase 2: Build the frontend. Python bindings are no longer part of
    // the default build — `runt mcp` is Rust-native, and agents iterating
    // on runtimed-py should use `cargo xtask integration` (which runs
    // `maturin develop`) or rebuild via the nteract-dev MCP (`up
    // rebuild=true`). CI still runs maturin explicitly in build.yml.
    if rust_only {
        if skip_tauri {
            println!("Skipping frontend build (--rust-only)");
        } else {
            let dist_dir = Path::new("apps/notebook/dist");
            if !dist_dir.exists() {
                eprintln!("Error: No frontend build found at apps/notebook/dist");
                eprintln!("Run `cargo xtask build` (without --rust-only) first.");
                exit(1);
            }
            println!("Skipping frontend build (--rust-only), reusing existing assets");
        }
    } else {
        println!("Building frontend (notebook)...");
        run_frontend_build(true);
    }

    if skip_tauri {
        println!("Skipping Tauri debug binary build (--skip-tauri)");
        println!("Rust sidecar build complete");
        return;
    }

    // Phase 3: Tauri build. With all Rust already compiled and frontend
    // assets in place, this is mostly a link step.
    println!("Building debug binary (no bundle)...");
    run_cmd(
        "cargo",
        &[
            "tauri",
            "build",
            "--debug",
            "--no-bundle",
            "--config",
            r#"{"build":{"beforeBuildCommand":""}}"#,
        ],
    );

    // Write marker file to indicate this is a bundled build
    let marker = notebook_bundled_marker_path();
    fs::write(&marker, "bundled").unwrap_or_else(|e| {
        eprintln!("Warning: Could not write bundled marker: {e}");
    });

    println!(
        "Build complete: {}",
        cargo_debug_binary_path("notebook").display()
    );
}

fn cmd_run(notebook: Option<&str>) {
    let binary = cargo_debug_binary_path("notebook");
    let marker = notebook_bundled_marker_path();

    if !binary.exists() {
        eprintln!("Error: No binary found at {}", binary.display());
        eprintln!("Run `cargo xtask build` first.");
        exit(1);
    }

    if !marker.exists() {
        eprintln!("Error: Binary appears to be a dev build (expects Vite server).");
        eprintln!("Run `cargo xtask build` for a standalone bundled binary.");
        exit(1);
    }

    println!("Running notebook app...");
    match notebook {
        Some(path) => run_cmd(binary.to_string_lossy().as_ref(), &[path]),
        None => run_cmd(binary.to_string_lossy().as_ref(), &[]),
    }
}

fn print_e2e_help() {
    eprintln!("Usage: cargo xtask e2e [COMMAND]");
    eprintln!();
    eprintln!("Commands:");
    eprintln!(
        "  build                          Build the E2E binary (debug, with embedded WebDriver)"
    );
    eprintln!("  test                           Run E2E smoke tests (default if no command given)");
    eprintln!("  test-fixture <notebook> <spec>  Run a single fixture test");
    eprintln!("  test-all                       Run smoke + all fixture tests");
    eprintln!("  help                           Show this help");
}

fn cmd_e2e(args: Vec<String>) {
    let subcmd = args.first().map(|s| s.as_str()).unwrap_or("test");
    match subcmd {
        "build" => cmd_e2e_build(),
        "test" => cmd_e2e_test(args),
        "test-fixture" => cmd_e2e_test_fixture(args),
        "test-all" => cmd_e2e_test_all(),
        "help" | "--help" | "-h" => {
            print_e2e_help();
        }
        _ => {
            eprintln!("Unknown e2e subcommand: {subcmd}");
            eprintln!();
            print_e2e_help();
            exit(1);
        }
    }
}

fn cmd_e2e_build() {
    require_pnpm();
    require_tauri();

    // Build runtimed daemon binary for bundling (debug mode for faster builds)
    build_runtimed_daemon(false);

    // pnpm build runs: notebook UI. Set `VITE_E2E=1` so the bundler
    // keeps the E2E-only test bridge (`window.__nteractWidgetUpdate`,
    // `window.__nteractWidgetStore`) in the output — it's gated on
    // `import.meta.env.VITE_E2E` in `App.tsx` so production bundles
    // without this env var don't expose it.
    println!("Building frontend (notebook)...");
    std::env::set_var("VITE_E2E", "1");
    run_frontend_build(true);
    std::env::remove_var("VITE_E2E");

    println!("Building debug binary with WebDriver server...");
    run_cmd(
        "cargo",
        &[
            "tauri",
            "build",
            "--debug",
            "--no-bundle",
            "--features",
            "e2e-webdriver",
            "--config",
            r#"{"build":{"beforeBuildCommand":""}}"#,
        ],
    );

    println!(
        "Build complete: {}",
        cargo_debug_binary_path("notebook").display()
    );
    println!("The app embeds a WebDriver server on port 4445 (tauri-plugin-webdriver).");
}

/// Run a single E2E test session. Returns the test process exit code.
///
/// Spawns a dev daemon and the notebook app, waits for WebDriver on port
/// 4445, runs `pnpm test:e2e`, then cleans everything up.
fn run_e2e_session(
    notebook_path: Option<&str>,
    spec_path: Option<&str>,
    workspace_dir: Option<&str>,
) -> i32 {
    // Ensure e2e binary exists
    if !cargo_debug_binary_path("notebook").exists() {
        cmd_e2e_build();
    }

    // Start daemon
    let mut daemon = if let Some(ws) = workspace_dir {
        // Custom workspace: spawn daemon with overridden RUNTIMED_WORKSPACE_PATH
        ensure_dev_daemon_binaries();
        let mut cmd = Command::new(dev_daemon_binary(false));
        cmd.args(["--dev", "run"])
            .env("RUNTIMED_DEV", "1")
            .env("RUNTIMED_WORKSPACE_PATH", ws)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = cmd.spawn().unwrap_or_else(|e| {
            eprintln!("Failed to start daemon: {e}");
            exit(1);
        });
        relay_child_output("daemon", child.stdout.take());
        relay_child_output("daemon", child.stderr.take());
        // Can't use wait_for_dev_daemon with a non-default workspace, poll briefly
        println!("Waiting for daemon to initialize...");
        thread::sleep(Duration::from_secs(10));
        child
    } else {
        let mut d = spawn_dev_daemon_process(false);
        if let Err(msg) = wait_for_dev_daemon(&mut d, Duration::from_secs(30)) {
            eprintln!("Failed to start dev daemon: {msg}");
            stop_child(&mut d, "daemon");
            return 1;
        }
        d
    };

    // Start the notebook app (embeds WebDriver on port 4445)
    let mut app_cmd = Command::new(cargo_debug_binary_path("notebook"));
    if let Some(path) = notebook_path {
        app_cmd.arg(path);
    }
    app_cmd.env("RUST_LOG", "info");
    if let Some(ws) = workspace_dir {
        app_cmd
            .env("RUNTIMED_DEV", "1")
            .env("RUNTIMED_WORKSPACE_PATH", ws)
            .current_dir(ws);
    } else {
        apply_worktree_env(&mut app_cmd, true);
    }
    app_cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut app = match app_cmd.spawn() {
        Ok(child) => child,
        Err(e) => {
            eprintln!("Failed to start notebook app: {e}");
            stop_child(&mut daemon, "daemon");
            return 1;
        }
    };
    relay_child_output("app", app.stdout.take());
    relay_child_output("app", app.stderr.take());

    // Wait for embedded WebDriver server on port 4445
    println!("Waiting for WebDriver on port 4445...");
    let wd_start = Instant::now();
    let wd_timeout = Duration::from_secs(30);
    let mut wd_ready = false;
    while wd_start.elapsed() < wd_timeout {
        if std::net::TcpStream::connect("127.0.0.1:4445").is_ok() {
            println!("WebDriver ready ({}s)", wd_start.elapsed().as_secs());
            wd_ready = true;
            break;
        }
        if app.try_wait().ok().flatten().is_some() {
            eprintln!("App exited before WebDriver became ready.");
            stop_child(&mut daemon, "daemon");
            return 1;
        }
        thread::sleep(Duration::from_secs(1));
    }
    if !wd_ready {
        eprintln!("Timed out waiting for WebDriver on port 4445.");
        stop_child(&mut app, "app");
        stop_child(&mut daemon, "daemon");
        return 1;
    }

    // Run pnpm test:e2e
    let pnpm = resolve_pnpm_command_or_exit();
    let args = ["test:e2e"];
    let mut test_cmd = pnpm.command();
    test_cmd.args(args).env("WEBDRIVER_PORT", "4445");
    if let Some(spec) = spec_path {
        test_cmd.env("E2E_SPEC", spec);
    }
    if let Some(ws) = workspace_dir {
        test_cmd.env("RUNTIMED_WORKSPACE_PATH", ws);
    }

    let test_code = match test_cmd.status() {
        Ok(s) => {
            if s.success() {
                0
            } else {
                s.code().unwrap_or(1)
            }
        }
        Err(e) => {
            eprintln!("Failed to run {}: {e}", pnpm.display_with_args(&args));
            1
        }
    };

    // Cleanup
    stop_child(&mut app, "app");
    stop_child(&mut daemon, "daemon");

    test_code
}

fn cmd_e2e_test(_args: Vec<String>) {
    println!("Running E2E smoke tests...");
    let code = run_e2e_session(None, None, None);
    exit(code);
}

fn cmd_e2e_test_fixture(args: Vec<String>) {
    let notebook_path = args.get(1).unwrap_or_else(|| {
        eprintln!("Usage: cargo xtask e2e test-fixture <notebook_path> <spec_path>");
        exit(1);
    });
    let spec_path = args.get(2).unwrap_or_else(|| {
        eprintln!("Usage: cargo xtask e2e test-fixture <notebook_path> <spec_path>");
        exit(1);
    });

    println!("Running E2E fixture test...");
    println!("  Notebook: {notebook_path}");
    println!("  Spec:     {spec_path}");

    let code = run_e2e_session(Some(notebook_path), Some(spec_path), None);
    exit(code);
}

fn cmd_e2e_test_all() {
    println!("Running native Tauri E2E tests...\n");
    let mut failed = false;

    // 1. Native smoke tests. Most notebook UI/runtime coverage runs through
    // Playwright via `pnpm --filter notebook-ui test:e2e:browser`.
    println!("=== Native Smoke Tests ===");
    if run_e2e_session(None, None, None) != 0 {
        eprintln!("Smoke tests failed.");
        failed = true;
    }

    // 2. Long-tail native-only fixture tests.
    let fixtures: &[(&str, &str, &str)] = &[(
        "crates/notebook/fixtures/audit-test/16-widget-slider.ipynb",
        "e2e/specs/widget-slider-stall.spec.js",
        "Widget Slider Stall Reproducer",
    )];

    for (notebook, spec, name) in fixtures {
        println!("\n=== {name} ===");
        if run_e2e_session(Some(notebook), Some(spec), None) != 0 {
            eprintln!("{name} failed.");
            failed = true;
        }
    }

    // 3. Untitled pyproject test (needs custom workspace directory)
    println!("\n=== Untitled Pyproject Test ===");
    let fixture_dir =
        std::fs::canonicalize("crates/notebook/fixtures/audit-test/pyproject-project")
            .unwrap_or_else(|e| {
                eprintln!("Failed to resolve pyproject fixture directory: {e}");
                exit(1);
            });
    let fixture_str = fixture_dir.to_string_lossy().to_string();
    if run_e2e_session(
        None,
        Some("e2e/specs/untitled-pyproject.spec.js"),
        Some(&fixture_str),
    ) != 0
    {
        eprintln!("Untitled Pyproject Test failed.");
        failed = true;
    }

    if failed {
        eprintln!("\nSome E2E tests failed.");
        exit(1);
    }
    println!("\nNative Tauri E2E tests passed!");
}

fn cmd_wasm(target: Option<&str>, skip_renderer_plugins: bool) {
    // `wasm-pack build crates/<name>` and the subsequent `fs::copy`/
    // `fs::read_dir` calls here all use repo-relative paths. cd to the
    // workspace root so this works whether the user invoked xtask from
    // the root, from `packages/sift`, or from anywhere else.
    ensure_workspace_root_cwd();
    require_tool("wasm-pack", WASM_PACK_INSTALL);

    // Default (no target) builds both. `sift` or `runtimed` pick just one.
    let (build_runtimed, build_sift) = match target {
        None | Some("--all") => (true, true),
        Some("sift") => (false, true),
        Some("runtimed") => (true, false),
        Some(other) => {
            eprintln!("Unknown wasm target: {other}. Use 'sift', 'runtimed', or '--all'.");
            std::process::exit(1);
        }
    };

    if build_runtimed {
        println!("Building runtimed-wasm...");
        run_wasm_pack(
            false,
            "wasm-pack",
            &[
                "build",
                "crates/runtimed-wasm",
                "--target",
                "web",
                "--out-dir",
                "../../apps/notebook/src/wasm/runtimed-wasm",
            ],
        );
        let _ = fs::remove_file("apps/notebook/src/wasm/runtimed-wasm/.gitignore");
        println!("WASM build complete. Output: apps/notebook/src/wasm/runtimed-wasm/");
        // Self-check: a fresh build must embed the current genesis seeds. This
        // turns a silently-stale bundle into a loud failure at build time, not
        // a broken notebook at runtime.
        cmd_verify_genesis();
        write_wasm_package_fingerprint(
            "runtimed-wasm",
            RUNTIMED_WASM_INPUTS,
            RUNTIMED_WASM_LOCK_ROOTS,
            Path::new(RUNTIMED_WASM_FINGERPRINT),
        );
    }

    if build_sift {
        println!("Building sift-wasm...");
        // Build to the canonical wasm-pack output location
        // (crates/sift-wasm/pkg/) — this is where
        //   - packages/sift/vite.config.ts aliases `sift-wasm`
        //   - packages/sift/vitest.config.ts looks for real glue
        //   - src/build/renderer-plugin-builder.ts::resolveWasmGlue()
        //     looks for real glue (falls back to __mocks__ stub otherwise)
        // expect it. If this path is empty, the renderer plugin bundles
        // the mock stub and sift renders "sift-wasm not built" at runtime.
        run_wasm_pack(
            true,
            "wasm-pack",
            &[
                "build",
                "crates/sift-wasm",
                "--target",
                "web",
                "--release",
                // Default --out-dir (./pkg) is what all consumers expect.
            ],
        );
        let _ = fs::remove_file("crates/sift-wasm/pkg/.gitignore");
        // Mirror the pkg to packages/sift/public/wasm/ for the sift demo
        // app's runtime fetch (vite base=/, served as static asset).
        let pkg_dir = Path::new("crates/sift-wasm/pkg");
        let public_dir = Path::new("packages/sift/public/wasm");
        if let Err(e) = fs::create_dir_all(public_dir) {
            eprintln!("Warning: failed to create {}: {e}", public_dir.display());
        } else {
            for entry in fs::read_dir(pkg_dir).into_iter().flatten().flatten() {
                let src = entry.path();
                let Some(name) = src.file_name() else {
                    continue;
                };
                let dest = public_dir.join(name);
                if let Err(e) = fs::copy(&src, &dest) {
                    eprintln!(
                        "Warning: failed to copy {} → {}: {e}",
                        src.display(),
                        dest.display()
                    );
                }
            }
        }
        println!(
            "WASM build complete. Output: crates/sift-wasm/pkg/ (mirrored to packages/sift/public/wasm/)"
        );
        write_wasm_package_fingerprint(
            "sift-wasm",
            SIFT_WASM_INPUTS,
            SIFT_WASM_LOCK_ROOTS,
            Path::new(SIFT_WASM_FINGERPRINT),
        );
    }

    // The sift renderer plugin bundle embeds wasm-bindgen glue from sift-wasm (the
    // `__wbg_*_<hash>` import names). Rebuilding sift-wasm without rebuilding
    // that plugin leaves it pointing at stale names — see #2048 (the
    // `__wbg_call_<hash> must be callable` runtime error). Chain the plugin
    // build by default so that class of drift can't happen via this command.
    //
    // `--skip-renderer-plugins` is the escape hatch for cases where you
    // explicitly want the drift (e.g. reproducing a bug against an older
    // bundle, or CI steps that intentionally test one half of the chain).
    if build_sift && !skip_renderer_plugins {
        println!();
        cmd_renderer_plugins(&["sift"]);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ArtifactAction {
    Status,
    Ensure,
    Verify,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ArtifactScope {
    Runtime,
    Sift,
    Renderer,
    McpWidget,
}

impl ArtifactScope {
    fn label(self) -> &'static str {
        match self {
            Self::Runtime => "runtime",
            Self::Sift => "sift",
            Self::Renderer => "renderer",
            Self::McpWidget => "mcp-widget",
        }
    }
}

const ALL_ARTIFACT_SCOPES: &[ArtifactScope] = &[
    ArtifactScope::Runtime,
    ArtifactScope::Sift,
    ArtifactScope::Renderer,
    ArtifactScope::McpWidget,
];

#[derive(Debug, Clone, PartialEq, Eq)]
struct ArtifactCommand {
    action: ArtifactAction,
    scopes: Vec<ArtifactScope>,
}

fn parse_artifact_command(args: &[String]) -> ArtifactCommand {
    let mut index = 0;
    let action = match args.first().map(String::as_str) {
        None => ArtifactAction::Status,
        Some("status") => {
            index = 1;
            ArtifactAction::Status
        }
        Some("ensure") => {
            index = 1;
            ArtifactAction::Ensure
        }
        Some("verify") => {
            index = 1;
            ArtifactAction::Verify
        }
        Some("--help" | "-h" | "help") => {
            print_artifacts_help();
            exit(0);
        }
        Some(value)
            if value == "all"
                || artifact_scope_from_str(value).is_some()
                || value.contains(',') =>
        {
            ArtifactAction::Status
        }
        Some(other) => {
            eprintln!("Unknown artifacts action or scope: {other}");
            eprintln!();
            print_artifacts_help();
            exit(1);
        }
    };

    let mut scopes = Vec::new();
    for arg in &args[index..] {
        if arg == "--help" || arg == "-h" {
            print_artifacts_help();
            exit(0);
        }
        for raw_scope in arg
            .split(',')
            .map(str::trim)
            .filter(|scope| !scope.is_empty())
        {
            if raw_scope == "all" {
                for scope in ALL_ARTIFACT_SCOPES {
                    push_artifact_scope(&mut scopes, *scope);
                }
                continue;
            }
            let Some(scope) = artifact_scope_from_str(raw_scope) else {
                eprintln!("Unknown artifact scope: {raw_scope}");
                eprintln!();
                print_artifacts_help();
                exit(1);
            };
            push_artifact_scope(&mut scopes, scope);
        }
    }

    if scopes.is_empty() {
        scopes.extend_from_slice(ALL_ARTIFACT_SCOPES);
    }

    ArtifactCommand { action, scopes }
}

fn print_artifacts_help() {
    eprintln!(
        "Usage: cargo xtask artifacts [status|ensure|verify] [scope[,scope]...]

Actions:
  status    Report artifact readiness without rebuilding (default)
  ensure    Rebuild missing or stale generated artifacts
  verify    Strictly verify artifacts and fail on drift or missing fingerprints

Scopes:
  runtime   apps/notebook/src/wasm/runtimed-wasm
  sift      crates/sift-wasm/pkg and packages/sift/public/wasm
  renderer  apps/notebook/src/renderer-plugins
  mcp-widget crates/runt-mcp/assets/_output.html and Python widget copy
  all       Every scope (default)
"
    );
}

fn artifact_scope_from_str(scope: &str) -> Option<ArtifactScope> {
    match scope {
        "runtime" | "runtimed" | "runtimed-wasm" => Some(ArtifactScope::Runtime),
        "sift" | "sift-wasm" => Some(ArtifactScope::Sift),
        "renderer" | "renderers" | "renderer-plugins" => Some(ArtifactScope::Renderer),
        "mcp-widget" | "mcp" | "widget" => Some(ArtifactScope::McpWidget),
        _ => None,
    }
}

fn push_artifact_scope(scopes: &mut Vec<ArtifactScope>, scope: ArtifactScope) {
    if !scopes.contains(&scope) {
        scopes.push(scope);
    }
}

fn cmd_artifacts(command: ArtifactCommand) {
    ensure_workspace_root_cwd();
    match command.action {
        ArtifactAction::Status => print_artifact_status(&command.scopes),
        ArtifactAction::Ensure => ensure_artifact_scopes(&command.scopes),
        ArtifactAction::Verify => verify_artifact_scopes_or_exit(&command.scopes),
    }
}

fn print_artifact_status(scopes: &[ArtifactScope]) {
    for scope in ordered_artifact_scopes(scopes) {
        match artifact_scope_reason(scope, false) {
            None => println!("ok     {}", scope.label()),
            Some(reason) => println!("needs  {} ({reason})", scope.label()),
        }
    }
}

fn ensure_artifact_scopes(scopes: &[ArtifactScope]) {
    let ordered = ordered_artifact_scopes(scopes);
    let mut sift_wasm_rebuilt = false;
    for scope in ordered {
        match scope {
            ArtifactScope::Runtime => {
                println!("[xtask] ensuring runtime artifacts");
                ensure_runtimed_wasm_current();
                verify_runtimed_wasm_genesis_after_ensure();
            }
            ArtifactScope::Sift => {
                println!("[xtask] ensuring sift artifacts");
                sift_wasm_rebuilt |= ensure_sift_wasm_current();
            }
            ArtifactScope::Renderer => {
                println!("[xtask] ensuring renderer artifacts");
                ensure_renderer_artifacts_current(sift_wasm_rebuilt);
                sift_wasm_rebuilt = false;
            }
            ArtifactScope::McpWidget => {
                println!("[xtask] ensuring MCP widget artifacts");
                build_mcp_widget();
            }
        }
    }
}

fn verify_artifact_scopes_or_exit(scopes: &[ArtifactScope]) {
    let mut ok = true;
    for scope in ordered_artifact_scopes(scopes) {
        match artifact_scope_reason(scope, true) {
            None => println!("ok  {} artifacts", scope.label()),
            Some(reason) => {
                eprintln!(
                    "::error::{} artifacts are not current ({reason})",
                    scope.label()
                );
                ok = false;
            }
        }
    }
    if !ok {
        exit(1);
    }
}

fn ordered_artifact_scopes(scopes: &[ArtifactScope]) -> Vec<ArtifactScope> {
    ALL_ARTIFACT_SCOPES
        .iter()
        .copied()
        .filter(|scope| scopes.contains(scope))
        .collect()
}

fn artifact_scope_reason(scope: ArtifactScope, strict: bool) -> Option<String> {
    match scope {
        ArtifactScope::Runtime => wasm_artifact_reason(
            "runtimed-wasm",
            RUNTIMED_WASM_OUTPUTS,
            RUNTIMED_WASM_INPUTS,
            RUNTIMED_WASM_LOCK_ROOTS,
            Path::new(RUNTIMED_WASM_FINGERPRINT),
            strict,
            || {
                if genesis_seeds_embedded(false) {
                    None
                } else {
                    Some("genesis seeds changed")
                }
            },
        ),
        ArtifactScope::Sift => wasm_artifact_reason(
            "sift-wasm",
            SIFT_WASM_OUTPUTS,
            SIFT_WASM_INPUTS,
            SIFT_WASM_LOCK_ROOTS,
            Path::new(SIFT_WASM_FINGERPRINT),
            strict,
            || None,
        ),
        ArtifactScope::Renderer => renderer_artifact_reason(strict),
        ArtifactScope::McpWidget => mcp_widget_artifact_reason(),
    }
}

fn wasm_artifact_reason(
    label: &str,
    outputs: &[&str],
    inputs: &[&str],
    lock_roots: &[&str],
    fingerprint_path: &Path,
    strict: bool,
    extra_reason: impl FnOnce() -> Option<&'static str>,
) -> Option<String> {
    let current_fingerprint = wasm_input_fingerprint(inputs, lock_roots);
    let reason = if strict {
        wasm_package_verify_reason(
            outputs,
            fingerprint_path,
            current_fingerprint.as_deref(),
            extra_reason,
        )
    } else {
        wasm_package_rebuild_reason(
            label,
            outputs,
            inputs,
            fingerprint_path,
            current_fingerprint.as_deref(),
            extra_reason,
        )
    };
    reason.map(str::to_string)
}

fn renderer_artifact_reason(strict: bool) -> Option<String> {
    for output in LFS_RENDERER_PLUGIN_OUTPUTS {
        let path = Path::new(output);
        if !path.exists() {
            return Some(format!("missing {output}"));
        }
        if is_git_lfs_pointer_file(path) {
            return Some(format!("{output} is a Git LFS pointer; run `git lfs pull`"));
        }
    }
    for output in GENERATED_RENDERER_PLUGIN_OUTPUTS {
        let path = Path::new(output);
        if !path.exists() {
            return Some(format!(
                "missing generated {output}; run `cargo xtask artifacts ensure sift,renderer`"
            ));
        }
        if is_git_lfs_pointer_file(path) {
            return Some(format!(
                "{output} is an old Git LFS pointer; run `cargo xtask artifacts ensure sift,renderer`"
            ));
        }
    }

    match (
        sift_wasm_source_fingerprint(),
        read_renderer_plugins_fingerprint(),
    ) {
        (Some(current), Some(previous)) if current == previous => {}
        (Some(_), Some(_)) => return Some("sift-wasm source changed".to_string()),
        (Some(_), None) if strict => return Some("input fingerprint missing".to_string()),
        (Some(_), None) => {}
        (None, _) => return Some("could not fingerprint renderer plugin inputs".to_string()),
    }

    match verify_plugin_against_wasm(
        Path::new("apps/notebook/src/renderer-plugins/sift.js"),
        Path::new("crates/sift-wasm/pkg/sift_wasm_bg.wasm"),
    ) {
        Ok(_) => None,
        Err(msg) => Some(msg.to_string()),
    }
}

fn is_git_lfs_pointer_file(path: &Path) -> bool {
    fs::read_to_string(path)
        .map(|contents| contents.starts_with("version https://git-lfs.github.com/spec/"))
        .unwrap_or(false)
}

fn mcp_widget_artifact_reason() -> Option<String> {
    mcp_widget_needs_rebuild().map(str::to_string)
}

fn parse_renderer_plugin_targets(args: &[String]) -> Vec<String> {
    let mut only = Vec::new();
    let mut saw_only = false;
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        if arg == "--help" || arg == "-h" {
            eprintln!("Usage: cargo xtask renderer-plugins [--only <target>[,<target>...]]");
            eprintln!();
            eprintln!(
                "Targets: isolated-renderer, core, markdown, plotly, bokeh, panel, vega, leaflet, sift"
            );
            exit(0);
        }
        if arg == "--only" {
            saw_only = true;
            let Some(value) = args.get(index + 1) else {
                eprintln!("Missing renderer plugin target after --only");
                exit(1);
            };
            only.extend(split_renderer_plugin_targets(value));
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--only=") {
            saw_only = true;
            only.extend(split_renderer_plugin_targets(value));
            index += 1;
            continue;
        }
        eprintln!("Unknown renderer-plugins argument: {arg}");
        exit(1);
    }
    if saw_only && only.is_empty() {
        eprintln!("No renderer plugin targets specified");
        exit(1);
    }
    only
}

fn split_renderer_plugin_targets(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(str::trim)
        .filter(|target| !target.is_empty())
        .map(ToString::to_string)
        .collect()
}

fn cmd_renderer_plugins(only: &[&str]) {
    // The `node scripts/build-renderer-plugins.ts` call below resolves
    // the script path against cwd — normalize it so this works from
    // any subdirectory.
    ensure_workspace_root_cwd();
    require_pnpm();
    ensure_pnpm_install();
    println!("Building renderer plugins...");
    // Single canonical output: apps/notebook/src/renderer-plugins/. The
    // notebook Vite app loads these directly; runtimed `include_bytes!`-es
    // them and wraps `.js` at serve time for MCP App consumers.
    let mut args = vec![
        "--experimental-strip-types",
        "scripts/build-renderer-plugins.ts",
    ];
    for &target in only {
        args.push("--only");
        args.push(target);
    }
    run_cmd("node", &args);
    println!("Renderer plugins built.");
    println!("  Output: apps/notebook/src/renderer-plugins/");
    if only.is_empty() {
        println!(
            "LFS-tracked bundles: plotly, vega, leaflet. Generated bundles: isolated-renderer, markdown, sift."
        );
    } else {
        println!("  Targets: {}", only.join(", "));
    }
    if renderer_plugin_targets_include_sift(only) {
        write_current_renderer_plugins_fingerprint();
    }
}

fn renderer_plugin_targets_include_sift(only: &[&str]) -> bool {
    only.is_empty() || only.contains(&"sift")
}

/// Verify renderer plugin bundles are coherent with their paired wasm binaries.
///
/// The #2048 failure mode looked like this: wasm was rebuilt (new mangled
/// `__wbg_call_<hash>` import names), but the plugin JS bundle was not.
/// Browser loads the plugin, plugin imports names that don't exist on the
/// current wasm, error: `import function ./sift_wasm_bg.js:__wbg_* must be
/// callable`.
///
/// Strict byte-level drift checks can't enforce this because wasm-pack output
/// is not bit-reproducible across macOS and Linux. Instead we check a weaker
/// but sufficient invariant: every wasm-bindgen import name referenced in the
/// plugin JS must be exported by the paired wasm binary.
///
/// If this ever has a false positive, the paired-file list or the symbol
/// regex is the place to look.
fn cmd_verify_plugins() {
    ensure_workspace_root_cwd();

    // (plugin bundle JS, paired wasm binary). Extend when a new wasm-backed
    // renderer plugin lands. Only one pair now that renderer plugins have a
    // single canonical output - runtimed wraps on serve instead of building
    // a second MCP-only copy.
    let pairs: &[(&str, &str)] = &[(
        "apps/notebook/src/renderer-plugins/sift.js",
        "crates/sift-wasm/pkg/sift_wasm_bg.wasm",
    )];

    let mut failed = false;
    for (plugin_js, wasm_path) in pairs {
        match verify_plugin_against_wasm(Path::new(plugin_js), Path::new(wasm_path)) {
            Ok(count) => {
                println!("  ok  {plugin_js} ({count} imports match {wasm_path})");
            }
            Err(msg) => {
                eprintln!("::error file={plugin_js}::{msg}");
                failed = true;
            }
        }
    }

    if failed {
        eprintln!();
        eprintln!(
            "Plugin bundle is out of sync with its wasm artifact. Run \
             `cargo xtask wasm && cargo xtask renderer-plugins` and commit \
             the updated files."
        );
        exit(1);
    }

    println!("All renderer plugin bundles match their wasm artifacts.");
}

/// Genesis seeds that must be embedded byte-for-byte in the built
/// `runtimed-wasm`. These `.am` files are the frozen Automerge roots the daemon
/// loads via `include_bytes!`; the frontend wasm is compiled from the same
/// crates and so embeds the same bytes in its data section. If a schema bump
/// regenerates a seed but the gitignored wasm bundle is not rebuilt, the daemon
/// and frontend end up on different roots, their docs cannot sync-merge, and
/// opening a notebook fails (see the v4->v5 regression in #3086). This check
/// catches that drift before it ships.
const GENESIS_SEEDS_IN_WASM: &[(&str, &str)] = &[
    (
        "notebook genesis",
        "crates/notebook-doc/assets/notebook_genesis_v5.am",
    ),
    (
        "runtime-state genesis",
        "crates/runtime-doc/assets/runtime_state_genesis_v2.am",
    ),
    (
        "comms-doc genesis",
        "crates/runtime-doc/assets/comms_doc_genesis_v1.am",
    ),
    (
        "comments-doc genesis",
        "crates/comments-doc/assets/comments_doc_genesis_v1.am",
    ),
];

const RUNTIMED_WASM_BINARY: &str = "apps/notebook/src/wasm/runtimed-wasm/runtimed_wasm_bg.wasm";

/// Verify the built `runtimed-wasm` embeds the current genesis seeds, so the
/// frontend and daemon agree on the Automerge root. Run after the wasm is built
/// (CI `build-runtime-artifacts`, or `cargo xtask wasm`).
fn cmd_verify_genesis() {
    ensure_workspace_root_cwd();
    if !genesis_seeds_embedded(true) {
        eprintln!();
        eprintln!(
            "runtimed-wasm is out of sync with the genesis seed(s). The frontend would load a \
             different Automerge root than the daemon, breaking notebook open/sync. \
             Rebuild and commit: `cargo xtask wasm runtimed --skip-renderer-plugins`."
        );
        exit(1);
    }
    println!("runtimed-wasm embeds the current genesis seeds.");
}

/// Ensure the built `runtimed-wasm` matches current source inputs and genesis
/// seeds, rebuilding it if stale or missing. Wired into the app build
/// (`prebuild`) so a desktop build can never package a wasm whose Automerge
/// root diverges from the daemon — the exact gap that shipped the #3086
/// regression from a local build where the daemon was rebuilt but the
/// gitignored wasm was not.
fn cmd_wasm_ensure_runtime() {
    ensure_workspace_root_cwd();
    ensure_runtimed_wasm_current();
    verify_runtimed_wasm_genesis_after_ensure();
}

fn verify_runtimed_wasm_genesis_after_ensure() {
    // cmd_wasm self-verifies on the runtimed rebuild path, so a still-stale
    // result there already aborts. This re-check covers the skip path and
    // missing-wasm cases.
    if !genesis_seeds_embedded(true) {
        eprintln!("::error::runtimed-wasm still does not embed the current genesis after rebuild.");
        exit(1);
    }
}

/// Verify prebuilt WASM artifacts without rebuilding them. This is for CI jobs
/// that downloaded the `wasm-artifacts` bundle from a build-wasm job and should
/// never need `wasm-pack` in the consumer job.
fn cmd_wasm_verify() {
    ensure_workspace_root_cwd();

    let mut ok = true;
    ok &= verify_wasm_package_current(
        "runtimed-wasm",
        RUNTIMED_WASM_OUTPUTS,
        RUNTIMED_WASM_INPUTS,
        RUNTIMED_WASM_LOCK_ROOTS,
        Path::new(RUNTIMED_WASM_FINGERPRINT),
        || {
            if genesis_seeds_embedded(false) {
                None
            } else {
                Some("genesis seeds changed")
            }
        },
    );
    ok &= verify_wasm_package_current(
        "sift-wasm",
        SIFT_WASM_OUTPUTS,
        SIFT_WASM_INPUTS,
        SIFT_WASM_LOCK_ROOTS,
        Path::new(SIFT_WASM_FINGERPRINT),
        || None,
    );
    ok &= verify_renderer_plugins_current();

    if !ok {
        eprintln!(
            "Downloaded WASM artifacts are not current for this checkout. \
             Rebuild them with `cargo xtask wasm` and upload the matching \
             target/xtask/*.fingerprint files."
        );
        exit(1);
    }
}

fn verify_renderer_plugins_current() -> bool {
    let mut ok = true;
    for output in RENDERER_PLUGIN_OUTPUTS {
        if !Path::new(output).exists() {
            eprintln!("::error file={output}::renderer plugin artifact is missing");
            ok = false;
        }
    }

    match (
        sift_wasm_source_fingerprint(),
        read_renderer_plugins_fingerprint(),
    ) {
        (Some(current), Some(previous)) if current == previous => {
            println!("[xtask] verified renderer plugin source fingerprint");
        }
        (Some(_), Some(_)) => {
            eprintln!("::error::renderer plugin artifacts are stale (sift-wasm source changed)");
            ok = false;
        }
        (Some(_), None) => {
            eprintln!("::error::renderer plugin input fingerprint missing");
            ok = false;
        }
        (None, _) => {
            eprintln!("::error::could not fingerprint renderer plugin inputs");
            ok = false;
        }
    }

    match verify_plugin_against_wasm(
        Path::new("apps/notebook/src/renderer-plugins/sift.js"),
        Path::new("crates/sift-wasm/pkg/sift_wasm_bg.wasm"),
    ) {
        Ok(count) => {
            println!("[xtask] verified sift renderer plugin ({count} imports match sift-wasm)");
        }
        Err(msg) => {
            eprintln!("::error file=apps/notebook/src/renderer-plugins/sift.js::{msg}");
            ok = false;
        }
    }

    if ok {
        println!("[xtask] verified renderer plugin artifacts");
    }
    ok
}

/// Check whether the built `runtimed-wasm` embeds every current genesis seed.
/// When `verbose`, prints per-seed ok/error lines (GitHub-annotated). Returns
/// `false` if the wasm is missing or any seed is absent.
fn genesis_seeds_embedded(verbose: bool) -> bool {
    let wasm = match fs::read(RUNTIMED_WASM_BINARY) {
        Ok(bytes) => bytes,
        Err(e) => {
            if verbose {
                eprintln!(
                    "::error file={RUNTIMED_WASM_BINARY}::cannot read runtimed-wasm ({e}). \
                     Build it with `cargo xtask wasm runtimed`."
                );
            }
            return false;
        }
    };

    let mut all_present = true;
    for (label, seed_path) in GENESIS_SEEDS_IN_WASM {
        let seed = match fs::read(seed_path) {
            Ok(bytes) => bytes,
            Err(e) => {
                if verbose {
                    eprintln!("::error file={seed_path}::cannot read {label} seed ({e})");
                }
                all_present = false;
                continue;
            }
        };
        if bytes_contain(&wasm, &seed) {
            if verbose {
                println!("  ok  runtimed-wasm embeds current {label} ({seed_path})");
            }
        } else {
            if verbose {
                eprintln!(
                    "::error file={seed_path}::runtimed-wasm does NOT embed the current {label}. \
                     The wasm bundle is stale relative to the source seed."
                );
            }
            all_present = false;
        }
    }
    all_present
}

/// True if `haystack` contains `needle` as a contiguous byte sequence. Naive
/// search keyed on the first byte; fine for a one-shot check of a ~200-byte
/// seed against a few-MB wasm, and keeps xtask free of a search dependency.
fn bytes_contain(haystack: &[u8], needle: &[u8]) -> bool {
    if needle.is_empty() || needle.len() > haystack.len() {
        return false;
    }
    let first = needle[0];
    haystack[..=haystack.len() - needle.len()]
        .iter()
        .enumerate()
        .filter(|(_, &b)| b == first)
        .any(|(i, _)| &haystack[i..i + needle.len()] == needle)
}

/// Inspect a wasm file's imports, scanning for the wasm-bindgen glue names
/// (`__wbg_*`, `__wbindgen_*`). Hand-rolled so xtask doesn't pick up a wasm
/// parsing dep (keeps `cargo xtask lint` fast).
///
/// Format we walk (Web Assembly Core Spec 1.0, binary format):
///
/// ```text
/// Module := \0 a s m \x01 \0 \0 \0      magic + version
///           (SectionId:u8  Size:ULEB128  Payload[Size])*
/// ImportSection (id=2) payload := n:ULEB128  Import[n]
/// Import := module:Name  name:Name  desc:ImportDesc
/// Name   := len:ULEB128  bytes[len] (UTF-8)
/// ```
///
/// We only need the names, so once we find section id=2 we walk `n` imports,
/// read each pair of length-prefixed strings, and skip past the import
/// descriptor (type, table, memory, or global) without fully decoding it.
fn wasm_bindgen_imports(wasm_path: &Path) -> Result<Vec<String>, String> {
    let bytes =
        fs::read(wasm_path).map_err(|e| format!("failed to read {}: {e}", wasm_path.display()))?;
    parse_wasm_bindgen_imports(&bytes).map_err(|e| format!("{}: {e}", wasm_path.display()))
}

fn parse_wasm_bindgen_imports(bytes: &[u8]) -> Result<Vec<String>, String> {
    if bytes.len() < 8 || &bytes[..4] != b"\0asm" {
        return Err("not a wasm file (missing \\0asm magic)".into());
    }
    // Skip magic (4) + version (4).
    let mut cur = Cursor::new(&bytes[8..]);

    loop {
        let Some(section_id) = cur.read_u8() else {
            return Ok(Vec::new()); // reached EOF with no import section
        };
        let section_size = cur.read_uleb128()? as usize;
        let section_end = cur.pos + section_size;
        if section_end > cur.buf.len() {
            return Err(format!(
                "section {section_id} length {section_size} overruns file"
            ));
        }

        if section_id == 2 {
            // Import section.
            let mut section = Cursor::new(&cur.buf[cur.pos..section_end]);
            let count = section.read_uleb128()? as usize;
            let mut out = Vec::new();
            for _ in 0..count {
                let _module = section.read_name()?;
                let name = section.read_name()?;
                section.skip_import_desc()?;
                if name.starts_with("__wbg_") || name.starts_with("__wbindgen_") {
                    out.push(name.to_string());
                }
            }
            return Ok(out);
        }

        cur.pos = section_end;
    }
}

struct Cursor<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Cursor<'a> {
    fn new(buf: &'a [u8]) -> Self {
        Self { buf, pos: 0 }
    }

    fn read_u8(&mut self) -> Option<u8> {
        let b = *self.buf.get(self.pos)?;
        self.pos += 1;
        Some(b)
    }

    fn read_uleb128(&mut self) -> Result<u64, String> {
        let mut result: u64 = 0;
        let mut shift = 0;
        loop {
            let byte = self
                .read_u8()
                .ok_or_else(|| "unexpected EOF in LEB128".to_string())?;
            result |= u64::from(byte & 0x7f) << shift;
            if byte & 0x80 == 0 {
                return Ok(result);
            }
            shift += 7;
            if shift > 63 {
                return Err("LEB128 value too large".into());
            }
        }
    }

    fn read_name(&mut self) -> Result<&'a str, String> {
        let len = self.read_uleb128()? as usize;
        let end = self.pos + len;
        if end > self.buf.len() {
            return Err(format!(
                "name length {len} overruns buffer (pos={})",
                self.pos
            ));
        }
        let s = std::str::from_utf8(&self.buf[self.pos..end])
            .map_err(|e| format!("invalid UTF-8 in name: {e}"))?;
        self.pos = end;
        Ok(s)
    }

    /// Skip past an ImportDesc entry. Four shapes:
    ///   0x00 TypeIdx           (1 u32 index)
    ///   0x01 TableType         (elem_type u8, limits)
    ///   0x02 MemType           (limits)
    ///   0x03 GlobalType        (val_type u8, mut u8)
    /// Where limits = flags:u8, min:u32, and max:u32 if flags bit 0 is set.
    fn skip_import_desc(&mut self) -> Result<(), String> {
        let kind = self
            .read_u8()
            .ok_or_else(|| "unexpected EOF in import descriptor".to_string())?;
        match kind {
            0x00 => {
                self.read_uleb128()?;
            }
            0x01 => {
                // elem type (anyfunc/externref, 1 byte in MVP)
                self.read_u8()
                    .ok_or_else(|| "EOF in table elem type".to_string())?;
                self.skip_limits()?;
            }
            0x02 => {
                self.skip_limits()?;
            }
            0x03 => {
                self.read_u8()
                    .ok_or_else(|| "EOF in global val type".to_string())?;
                self.read_u8()
                    .ok_or_else(|| "EOF in global mutability".to_string())?;
            }
            other => return Err(format!("unknown import descriptor kind 0x{other:02x}")),
        }
        Ok(())
    }

    fn skip_limits(&mut self) -> Result<(), String> {
        let flags = self
            .read_u8()
            .ok_or_else(|| "EOF in limits flags".to_string())?;
        self.read_uleb128()?; // min
        if flags & 0x01 != 0 {
            self.read_uleb128()?; // max
        }
        Ok(())
    }
}

fn verify_plugin_against_wasm(plugin_js: &Path, wasm_path: &Path) -> Result<usize, String> {
    const WASM_URL_SENTINEL: &str = "__wasm_loaded_via_setWasmUrl__";

    if !plugin_js.exists() {
        return Err(format!("plugin bundle missing: {}", plugin_js.display()));
    }
    if !wasm_path.exists() {
        return Err(format!("wasm binary missing: {}", wasm_path.display()));
    }

    let imports = wasm_bindgen_imports(wasm_path)?;
    if imports.is_empty() {
        // Not an error — a wasm module may legitimately have no wasm-bindgen
        // imports. But flag it so we don't silently pass after a refactor
        // that accidentally empties the list.
        return Err(format!(
            "{} has no __wbg_/__wbindgen_ imports — refusing to vacuously pass the check",
            wasm_path.display()
        ));
    }

    let bundle = fs::read_to_string(plugin_js)
        .map_err(|e| format!("failed to read {}: {e}", plugin_js.display()))?;

    if !bundle.contains(WASM_URL_SENTINEL) {
        return Err(format!(
            "plugin bundle does not contain {WASM_URL_SENTINEL:?}; \
             exclude-wasm-inline may not have rewritten the wasm-bindgen URL"
        ));
    }

    let mut missing = Vec::new();
    for name in &imports {
        if !bundle.contains(name.as_str()) {
            missing.push(name.clone());
        }
    }

    if !missing.is_empty() {
        let preview: Vec<&String> = missing.iter().take(5).collect();
        return Err(format!(
            "plugin bundle does not reference {} wasm import name(s) from {}: e.g. {:?}",
            missing.len(),
            wasm_path.display(),
            preview,
        ));
    }

    Ok(imports.len())
}

fn cmd_icons(source: Option<&str>) {
    require_tauri();

    let default_source = "crates/notebook/icons/source.png";
    let source_path = source.unwrap_or(default_source);

    if !Path::new(source_path).exists() {
        eprintln!("Source icon not found: {source_path}");
        eprintln!("Export your icon from Figma to this location.");
        exit(1);
    }

    let output_dir = "crates/notebook/icons";

    println!("Generating icons from {source_path}...");
    run_cmd(
        "cargo",
        &["tauri", "icon", source_path, "--output", output_dir],
    );
    println!("Icons generated in {output_dir}/");
}

fn cmd_build_dmg() {
    build_with_bundle("dmg");
}

fn cmd_build_app() {
    build_with_bundle("app");
}

fn build_with_bundle(bundle: &str) {
    require_pnpm();
    require_tauri();

    // Same artifact-existence check as cmd_build, so packaging a release
    // works on a fresh clone (CI) without an explicit `cargo xtask wasm`.
    ensure_build_artifacts();

    // Ensure pnpm workspace deps are installed before anything else touches
    // pnpm — `run_frontend_build` below and any tauri `beforeBuildCommand`
    // assume node_modules is populated. Fresh clones would otherwise fail
    // with missing-workspace-package errors.
    ensure_pnpm_install();

    // Generate icons if source exists
    let source_path = "crates/notebook/icons/source.png";
    if Path::new(source_path).exists() {
        cmd_icons(None);
    } else {
        println!("Skipping icon generation (no source.png found)");
    }

    // Build runtimed daemon binary for bundling (release mode for distribution)
    build_runtimed_daemon(true);

    // Generate the SMAppService launch agent plist for inclusion in the bundle.
    // This must happen before `cargo tauri build` so the plist is signed with
    // the app bundle (modifying Contents/ after signing invalidates the signature).
    generate_launch_agent_plist();

    // Build frontend
    println!("Building frontend...");
    run_frontend_build(false);

    // Build Tauri app
    println!("Building Tauri app ({bundle} bundle)...");
    let tauri_config = launch_agent_tauri_config();
    run_cmd(
        "cargo",
        &[
            "tauri",
            "build",
            "--bundles",
            bundle,
            "--config",
            &tauri_config,
        ],
    );

    println!("Build complete!");
}

/// Build a Tauri `--config` override JSON that:
/// 1. Disables `beforeBuildCommand` (we already built the frontend)
/// 2. Includes the launch agent plist in the macOS bundle
///
/// The plist is included at `Contents/Library/LaunchAgents/<label>.plist`
/// so SMAppService can find it. The files map is channel-specific since
/// the label differs between stable and nightly.
fn launch_agent_tauri_config() -> String {
    let label = runt_workspace::daemon_launchd_label();
    let plist_filename = format!("{label}.plist");
    let bundle_dest = format!("Library/LaunchAgents/{plist_filename}");
    let source_path = format!("./launch-agents/{plist_filename}");

    // Build the config JSON with serde_json to avoid escaping issues
    let config = serde_json::json!({
        "build": {
            "beforeBuildCommand": ""
        },
        "bundle": {
            "macOS": {
                "files": {
                    bundle_dest: source_path
                }
            }
        }
    });

    config.to_string()
}

/// Generate the launch agent plist for SMAppService registration.
///
/// On macOS 13+, SMAppService looks for the plist inside the app bundle at
/// `Contents/Library/LaunchAgents/<label>.plist`. This function generates the
/// plist with channel-specific values and writes it to `crates/notebook/launch-agents/`
/// where `tauri.conf.json` picks it up via `bundle.macOS.files`.
///
/// The plist uses `BundleProgram` (bundle-relative path) instead of absolute
/// `ProgramArguments`, as required by SMAppService.
#[allow(clippy::expect_used)] // xtask is a dev tool; panics with context are fine
fn generate_launch_agent_plist() {
    let label = runt_workspace::daemon_launchd_label();
    let daemon_binary = runt_workspace::daemon_binary_basename();

    let log_level = match runt_workspace::build_channel() {
        runt_workspace::BuildChannel::Nightly => {
            "info,notebook_sync=debug,runtimed::notebook_sync_server=debug"
        }
        runt_workspace::BuildChannel::Stable => "warn",
    };

    // BundleProgram is relative to the .app bundle root
    let bundle_program = format!("Contents/MacOS/{daemon_binary}");

    // Note: HOME, USER, StandardOutPath, and StandardErrorPath are omitted
    // because they require the user's home directory which isn't known at
    // build time. This plist is only used on macOS 13+ where launchd's
    // user-domain agent loading reliably sets HOME and USER. The daemon
    // also manages its own log file internally and falls back to /tmp.
    //
    // This plist is additive — the legacy ~/Library/LaunchAgents/ plist
    // (which includes HOME, USER, and ~/.local/bin in PATH) is always
    // also written at install time and is the primary one used by
    // launchctl start/stop.

    let plist_content = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>{label}</string>
    <key>BundleProgram</key>
    <string>{bundle_program}</string>
    <key>ProgramArguments</key>
    <array>
        <string>{bundle_program}</string>
        <string>--log-level</string>
        <string>{log_level}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>Crashed</key>
        <true/>
    </dict>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
    </dict>
</dict>
</plist>
"#,
    );

    let output_dir = Path::new("crates/notebook/launch-agents");
    fs::create_dir_all(output_dir).expect("Failed to create launch-agents directory");

    let plist_filename = format!("{label}.plist");
    let output_path = output_dir.join(&plist_filename);
    fs::write(&output_path, plist_content).expect("Failed to write launch agent plist");

    println!("Generated launch agent plist: {}", output_path.display());
}

/// Build and run runtimed in per-worktree development mode.
///
/// This enables isolated daemon instances per git worktree, useful when
/// developing/testing daemon code across multiple worktrees simultaneously.
fn cmd_mcp(print_config: bool, release: bool) {
    // Skip ensure_python_env/ensure_maturin_develop here — the supervisor
    // handles maturin develop asynchronously in its background init task.
    // Removing these saves 5-15s of startup time.

    // Build the daemon in the requested mode so the supervisor finds it
    if release {
        println!("Building runtimed (release) for supervisor...");
        run_cmd("cargo", &["build", "--release", "-p", "runtimed"]);
        run_cmd("cargo", &["build", "--release", "-p", "runt"]);
    }

    if print_config {
        // Build the supervisor, then run it with --print-config
        // For now, print the config pointing at the binary
        run_cmd("cargo", &["build", "-p", "mcp-supervisor"]);
        let binary = cargo_debug_binary_path("mcp-supervisor");
        let binary_path = fs::canonicalize(&binary).unwrap_or_else(|e| {
            eprintln!(
                "Failed to resolve supervisor binary path at {}: {e}",
                binary.display()
            );
            exit(1);
        });
        let mut env_map = serde_json::Map::new();
        env_map.insert("RUNTIMED_DEV".into(), serde_json::json!("1"));
        if release {
            env_map.insert("RUNTIMED_RELEASE".into(), serde_json::json!("1"));
        }
        if let Some(path) = runt_workspace::get_workspace_path() {
            env_map.insert(
                "RUNTIMED_WORKSPACE_PATH".into(),
                serde_json::json!(path.to_string_lossy()),
            );
        }

        let config = serde_json::json!({
            "command": binary_path.to_string_lossy(),
            "env": env_map,
        });
        println!(
            "{}",
            serde_json::to_string_pretty(&config).unwrap_or_else(|e| {
                eprintln!("Failed to serialize config: {e}");
                exit(1);
            })
        );
        return;
    }

    // Build and exec the supervisor binary
    run_cmd("cargo", &["build", "-p", "mcp-supervisor"]);
    let binary = cargo_debug_binary_path("mcp-supervisor");

    let mut command = Command::new(&binary);
    apply_worktree_env(&mut command, true);
    if release {
        command.env("RUNTIMED_RELEASE", "1");
    }

    let status = command.status().unwrap_or_else(|e| {
        eprintln!("Failed to run mcp-supervisor: {e}");
        exit(1);
    });

    if !status.success() {
        exit(status.code().unwrap_or(1));
    }
}

fn cmd_mcp_inspector() {
    require_pnpm();

    // Build runt so it's ready when the inspector spawns it
    println!("Building runt CLI...");
    run_cmd("cargo", &["build", "-p", "runt"]);

    ensure_pnpm_install();

    let runt_binary = fs::canonicalize(dev_runt_cli_binary()).unwrap_or_else(|e| {
        eprintln!("Failed to resolve runt binary path: {e}");
        exit(1);
    });

    // Build a mcpServers config so nteract is pre-populated and auto-connects
    let mut env_map = serde_json::Map::new();
    env_map.insert("RUNTIMED_DEV".into(), serde_json::json!("1"));
    if let Some(path) = runt_workspace::get_workspace_path() {
        env_map.insert(
            "RUNTIMED_WORKSPACE_PATH".into(),
            serde_json::json!(path.to_string_lossy()),
        );
    }

    let config = serde_json::json!({
        "mcpServers": {
            "nteract": {
                "command": runt_binary.to_string_lossy(),
                "args": ["mcp"],
                "env": env_map,
            }
        }
    });

    let config_path = env::temp_dir().join("nteract-mcp-inspector.json");
    fs::write(&config_path, config.to_string()).unwrap_or_else(|e| {
        eprintln!("Failed to write inspector config: {e}");
        exit(1);
    });

    println!("Starting MCPJam Inspector...");
    println!("UI will open at http://localhost:6274");
    println!("Server: nteract (auto-connect)");
    println!("Ensure the dev daemon is running (cargo xtask dev-daemon).");
    println!();

    let config_str = config_path.to_string_lossy().to_string();
    let pnpm = resolve_pnpm_command_or_exit();
    let args = [
        "exec",
        "inspector",
        "--config",
        &config_str,
        "--server",
        "nteract",
    ];
    let mut command = pnpm.command();
    command.args(args);
    apply_worktree_env(&mut command, true);

    let status = command.status().unwrap_or_else(|e| {
        eprintln!("Failed to run {}: {e}", pnpm.display_with_args(&args));
        eprintln!("Ensure @mcpjam/inspector is in devDependencies and run `pnpm install`.");
        exit(1);
    });

    // Clean up temp config
    let _ = fs::remove_file(&config_path);

    if !status.success() {
        exit(status.code().unwrap_or(1));
    }
}

fn cmd_pi(pi_args: &[String]) {
    ensure_workspace_root_cwd();
    require_pnpm();
    ensure_pnpm_install();

    let local_pi = local_pi_binary();
    if !local_pi.exists() {
        eprintln!(
            "Error: local Pi binary was not found at {}",
            local_pi.display()
        );
        eprintln!("Run `pnpm install` and try again.");
        exit(1);
    }

    if pi_passthrough_without_extension(pi_args) {
        let status = Command::new(local_pi)
            .args(pi_args)
            .status()
            .unwrap_or_else(|e| {
                eprintln!("Failed to run Pi: {e}");
                exit(1);
            });
        exit_on_failed_status("pi", status);
        return;
    }

    println!("Building @runtimed/node debug binding...");
    run_pnpm(&["--dir", "packages/runtimed-node", "build:debug"]);

    if !dev_daemon_running() {
        eprintln!("Error: no dev daemon detected for this worktree.");
        eprintln!("Start one in another terminal first:");
        eprintln!();
        eprintln!("  cargo xtask dev-daemon");
        exit(1);
    }

    let extension_path = canonical_path("plugins/nteract/pi/extensions/repl.ts");
    let node_path = canonical_path("packages/runtimed-node/src/index.cjs");
    let socket_path = dev_socket_path();

    println!("Starting Pi with nteract extension...");
    println!("  extension: {}", extension_path.display());
    println!("  runtimed-node: {}", node_path.display());
    println!("  socket: {}", socket_path.display());
    println!();

    let mut command = Command::new(local_pi);
    command.arg("--extension").arg(extension_path);
    command.args(pi_args);
    command.env("NTERACT_RUNTIMED_NODE_PATH", node_path);
    // Socket selection flows through apply_worktree_env -> RUNTIMED_DEV +
    // RUNTIMED_WORKSPACE_PATH, which runtimed-node's defaultSocketPath()
    // resolves to the same per-worktree socket printed above.
    apply_worktree_env(&mut command, true);

    let status = command.status().unwrap_or_else(|e| {
        eprintln!("Failed to run Pi: {e}");
        exit(1);
    });
    exit_on_failed_status("pi", status);
}

fn pi_passthrough_without_extension(args: &[String]) -> bool {
    if args
        .iter()
        .any(|arg| matches!(arg.as_str(), "--help" | "-h" | "--version" | "-v"))
    {
        return true;
    }

    matches!(
        args.first().map(String::as_str),
        Some("install" | "remove" | "uninstall" | "update" | "list" | "config")
    )
}

fn local_pi_binary() -> PathBuf {
    let mut path = PathBuf::from("plugins/nteract/pi/node_modules/.bin/pi");
    if cfg!(windows) {
        path.set_extension("cmd");
    }
    path
}

fn canonical_path(path: impl AsRef<Path>) -> PathBuf {
    let path = path.as_ref();
    fs::canonicalize(path).unwrap_or_else(|e| {
        eprintln!("Failed to resolve {}: {e}", path.display());
        exit(1);
    })
}

fn workspace_root_or_exit() -> PathBuf {
    find_workspace_root().unwrap_or_else(|| {
        eprintln!("Error: could not resolve current Cargo workspace.");
        exit(1);
    })
}

fn cargo_profile_dir(profile: &str) -> PathBuf {
    let workspace = workspace_root_or_exit();
    runt_workspace::cargo_profile_dir_for_workspace(&workspace, profile)
}

fn cargo_binary_path(profile: &str, binary_name: &str) -> PathBuf {
    let workspace = workspace_root_or_exit();
    runt_workspace::cargo_binary_path_for_workspace(&workspace, profile, binary_name)
}

fn cargo_debug_binary_path(binary_name: &str) -> PathBuf {
    cargo_binary_path("debug", binary_name)
}

fn notebook_bundled_marker_path() -> PathBuf {
    let workspace = workspace_root_or_exit();
    runt_workspace::notebook_bundled_marker_for_workspace(&workspace)
}

fn dev_socket_path() -> PathBuf {
    let workspace = runt_workspace::get_workspace_path().unwrap_or_else(|| {
        eprintln!("Error: could not resolve current git worktree.");
        exit(1);
    });
    let hash = runt_workspace::worktree_hash(&workspace);
    dirs::cache_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join(runt_workspace::cache_namespace())
        .join("worktrees")
        .join(hash)
        .join("runtimed.sock")
}

fn cmd_dev_daemon(release: bool) {
    // runtimed's build.rs panics if the gitignored renderer-plugin
    // outputs are missing. Ensure they exist before kicking off the
    // cargo build so a fresh clone can run `cargo xtask dev-daemon`
    // directly.
    ensure_build_artifacts();

    if release {
        println!("Building runtimed (release)...");
        run_cmd("cargo", &["build", "--release", "-p", "runtimed"]);
    } else {
        println!("Building runtimed (debug)...");
        run_cmd("cargo", &["build", "-p", "runtimed"]);
    }

    let binary = dev_daemon_binary(release);

    if !binary.exists() {
        eprintln!(
            "Build succeeded but binary not found at {}",
            binary.display()
        );
        exit(1);
    }

    let cache_base = dirs::cache_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("/tmp"))
        .join(runt_workspace::cache_namespace())
        .join("worktrees");

    let state_dir = match runt_workspace::get_workspace_path() {
        Some(path) => cache_base.join(runt_workspace::worktree_hash(&path)),
        None => cache_base.join("<unknown>"),
    };

    println!();
    println!("Starting development daemon for this worktree...");
    println!("State will be stored in {}/", state_dir.display());
    println!("Press Ctrl+C to stop.");
    println!();

    let mut cmd = Command::new(&binary);
    cmd.args(["--dev", "run"]);
    apply_worktree_env(&mut cmd, true);
    let status = cmd.status().unwrap_or_else(|e| {
        eprintln!("Failed to run runtimed: {e}");
        exit(1);
    });

    if !status.success() {
        exit(status.code().unwrap_or(1));
    }
}

fn ensure_dev_daemon_binaries() {
    println!("Building runtimed + runt binaries for dev daemon...");
    build_runtimed_daemon(false);
}

fn spawn_dev_daemon_process(release: bool) -> Child {
    ensure_dev_daemon_binaries();

    let binary = dev_daemon_binary(release);
    let cache_base = dirs::cache_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("/tmp"))
        .join(runt_workspace::cache_namespace())
        .join("worktrees");

    let state_dir = match runt_workspace::get_workspace_path() {
        Some(path) => cache_base.join(runt_workspace::worktree_hash(&path)),
        None => cache_base.join("<unknown>"),
    };

    println!("State will be stored in {}/", state_dir.display());
    println!("Notebook command will stop the daemon when the app exits.");
    println!();

    let mut command = Command::new(binary);
    command
        .args(["--dev", "run"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    apply_worktree_env(&mut command, true);

    let mut child = command.spawn().unwrap_or_else(|e| {
        eprintln!("Failed to run runtimed: {e}");
        exit(1);
    });

    relay_child_output("daemon", child.stdout.take());
    relay_child_output("daemon", child.stderr.take());
    child
}

fn wait_for_dev_daemon(child: &mut Child, timeout: Duration) -> Result<(), String> {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("Failed to poll dev daemon status: {error}"))?
        {
            return Err(format!(
                "Development daemon exited before it became ready (status: {status})."
            ));
        }

        if dev_daemon_running() {
            return Ok(());
        }

        thread::sleep(Duration::from_millis(250));
    }

    Err("Timed out waiting for the development daemon to become ready.".to_string())
}

fn dev_daemon_running() -> bool {
    let mut command = Command::new(dev_runt_cli_binary());
    command
        .args(["daemon", "status", "--json"])
        .env("RUST_LOG", "error")
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    apply_worktree_env(&mut command, true);

    let status_reports_running = command
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| serde_json::from_slice::<serde_json::Value>(&output.stdout).ok())
        .and_then(|status_json| {
            status_json
                .get("running")
                .and_then(serde_json::Value::as_bool)
        })
        .unwrap_or(false);

    status_reports_running || dev_daemon_socket_reports_running()
}

#[cfg(unix)]
fn dev_daemon_socket_reports_running() -> bool {
    use std::io::Write as _;
    use std::os::unix::net::UnixStream;

    let Ok(mut stream) = UnixStream::connect(dev_socket_path()) else {
        return false;
    };
    let timeout = Some(Duration::from_millis(500));
    let _ = stream.set_read_timeout(timeout);
    let _ = stream.set_write_timeout(timeout);

    // Lightweight socket-source-of-truth probe. Keep this local to xtask so
    // `cargo xtask notebook` can detect an already-running dev daemon before
    // `target/debug/runt` has been built.
    if stream.write_all(&[0xC0, 0xDE, 0x01, 0xAC, 4]).is_err() {
        return false;
    }
    if send_json_frame_sync(&mut stream, &serde_json::json!({ "channel": "pool" })).is_err() {
        return false;
    }
    if send_json_frame_sync(
        &mut stream,
        &serde_json::json!({ "type": "get_daemon_info" }),
    )
    .is_err()
    {
        return false;
    }
    let Ok(response) = recv_json_frame_sync(&mut stream) else {
        return false;
    };
    response
        .get("type")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|kind| kind == "daemon_info")
}

#[cfg(not(unix))]
fn dev_daemon_socket_reports_running() -> bool {
    false
}

#[cfg(unix)]
fn send_json_frame_sync(
    stream: &mut impl std::io::Write,
    value: &serde_json::Value,
) -> std::io::Result<()> {
    let payload = serde_json::to_vec(value).map_err(std::io::Error::other)?;
    stream.write_all(&(payload.len() as u32).to_be_bytes())?;
    stream.write_all(&payload)?;
    stream.flush()
}

#[cfg(unix)]
fn recv_json_frame_sync(stream: &mut impl std::io::Read) -> std::io::Result<serde_json::Value> {
    let mut len_buf = [0u8; 4];
    stream.read_exact(&mut len_buf)?;
    let len = u32::from_be_bytes(len_buf) as usize;
    if len > 64 * 1024 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("daemon info response too large: {len} bytes"),
        ));
    }
    let mut payload = vec![0u8; len];
    stream.read_exact(&mut payload)?;
    serde_json::from_slice(&payload).map_err(std::io::Error::other)
}

fn dev_daemon_binary(release: bool) -> PathBuf {
    cargo_binary_path(if release { "release" } else { "debug" }, "runtimed")
}

fn dev_runt_cli_binary() -> PathBuf {
    cargo_debug_binary_path("runt")
}

fn relay_child_output<R>(label: &'static str, stream: Option<R>)
where
    R: std::io::Read + Send + 'static,
{
    let Some(stream) = stream else {
        return;
    };

    thread::spawn(move || {
        let reader = BufReader::new(stream);
        for line in reader.lines() {
            match line {
                Ok(line) => eprintln!("[{label}] {line}"),
                Err(_) => break,
            }
        }
    });
}

fn stop_child(child: &mut Child, label: &str) {
    match child.try_wait() {
        Ok(Some(_)) => {}
        Ok(None) => {
            println!("Stopping {label}...");
            let _ = child.kill();
            let _ = child.wait();
        }
        Err(error) => {
            eprintln!("Failed to poll {label}: {error}");
        }
    }
}

fn resolve_vite_port(force_dev_mode: bool) -> Option<String> {
    env::var("RUNTIMED_VITE_PORT")
        .ok()
        .or_else(|| env::var("CONDUCTOR_PORT").ok())
        .or_else(|| {
            if force_dev_mode {
                default_dev_vite_port().map(|port| port.to_string())
            } else {
                None
            }
        })
}

fn default_dev_vite_port() -> Option<u16> {
    runt_workspace::default_vite_port()
}

/// Run linting and formatting checks across all languages.
///
/// In check mode (default): exits non-zero if any issues are found.
/// In fix mode (--fix): auto-fixes issues where possible.
fn cmd_lint(fix: bool) {
    let mode = if fix { "fix" } else { "check" };
    println!("Running lint ({mode} mode)...");
    println!();

    // Track if any linter failed
    let mut failed = false;

    // Fast checks first — these finish in seconds and catch the most common issues.

    // Rust formatting
    println!("=== Rust formatting ===");
    if fix {
        if !run_cmd_ok("cargo", &["fmt"]) {
            failed = true;
        }
    } else if !run_cmd_ok("cargo", &["fmt", "--check"]) {
        failed = true;
    }
    println!();

    println!("=== Raw control bytes ===");
    if !check_raw_control_bytes() {
        failed = true;
    }
    println!();

    // JavaScript/TypeScript with Vite Plus
    println!("=== JavaScript/TypeScript (vp check) ===");
    let vp_ok = if fix {
        run_pnpm_ok(&["exec", "vp", "check", "--fix"])
    } else {
        run_pnpm_ok(&["exec", "vp", "check"])
    };
    if !vp_ok {
        failed = true;
    }
    println!();

    // Python with ruff (if uv is available and pyproject.toml exists at root)
    if Path::new("pyproject.toml").exists() {
        if Command::new("uv").arg("--version").output().is_ok() {
            println!("=== Python (ruff) ===");

            // ruff check
            let check_args = if fix {
                vec!["run", "ruff", "check", "--fix", "."]
            } else {
                vec!["run", "ruff", "check", "."]
            };
            let check_status = Command::new("uv").args(&check_args).status();
            if !check_status.map(|s| s.success()).unwrap_or(false) {
                failed = true;
            }

            // ruff format
            let format_args = if fix {
                vec!["run", "ruff", "format", "."]
            } else {
                vec!["run", "ruff", "format", "--check", "."]
            };
            let format_status = Command::new("uv").args(&format_args).status();
            if !format_status.map(|s| s.success()).unwrap_or(false) {
                failed = true;
            }
            println!();

            // ty type-check. ty is a dev-dep at the workspace root; the
            // python-package workflow already gates PRs on it, so we run
            // the same command here to give local `cargo xtask lint` the
            // same coverage. `ty check` is read-only — the --fix flag has
            // no effect on it.
            println!("=== Python (ty) ===");
            let ty_status = Command::new("uv")
                .args(["run", "ty", "check", "python/"])
                .status();
            if !ty_status.map(|s| s.success()).unwrap_or(false) {
                failed = true;
            }
            println!();
        } else {
            println!("=== Python (ruff + ty) ===");
            println!("Skipping: uv not found in PATH");
            println!();
        }
    }

    if failed {
        if fix {
            eprintln!("Some issues could not be auto-fixed. See output above.");
        } else {
            eprintln!("Lint check failed. Run `cargo xtask lint --fix` to auto-fix.");
        }
        exit(1);
    }

    println!("All checks passed!");
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RawControlByte {
    byte: u8,
    offset: usize,
    line: usize,
    column: usize,
}

fn first_raw_control_byte(bytes: &[u8]) -> Option<RawControlByte> {
    let mut line = 1usize;
    let mut column = 1usize;

    for (offset, &byte) in bytes.iter().enumerate() {
        if byte < 0x20 && !matches!(byte, b'\t' | b'\n' | b'\r') {
            return Some(RawControlByte {
                byte,
                offset,
                line,
                column,
            });
        }

        if byte == b'\n' {
            line += 1;
            column = 1;
        } else {
            column += 1;
        }
    }

    None
}

fn normalized_repo_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn is_known_generated_text_bundle(path: &Path) -> bool {
    let path = normalized_repo_path(path);
    path.starts_with("apps/notebook/src/renderer-plugins/")
        || path.starts_with("apps/elements/public/wasm/")
}

fn should_scan_for_raw_control_bytes(path: &Path) -> bool {
    if is_known_generated_text_bundle(path) {
        return false;
    }

    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    if matches!(
        file_name,
        ".env"
            | ".env.example"
            | ".gitattributes"
            | ".gitignore"
            | ".npmrc"
            | ".yarnrc"
            | "AGENTS.md"
            | "Cargo.lock"
            | "Dockerfile"
            | "README.md"
            | "package.json"
            | "pnpm-lock.yaml"
            | "pyproject.toml"
    ) {
        return true;
    }

    matches!(
        path.extension()
            .and_then(|extension| extension.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some(
            "bash"
                | "cfg"
                | "cjs"
                | "css"
                | "env"
                | "fish"
                | "html"
                | "ini"
                | "js"
                | "json"
                | "jsonl"
                | "jsx"
                | "lock"
                | "md"
                | "mdx"
                | "mjs"
                | "py"
                | "rs"
                | "sh"
                | "sql"
                | "toml"
                | "ts"
                | "tsx"
                | "txt"
                | "yaml"
                | "yml"
                | "zsh"
        )
    )
}

fn tracked_files() -> Result<Vec<PathBuf>, String> {
    let output = Command::new("git")
        .args(["ls-files", "-z"])
        .output()
        .map_err(|error| format!("failed to run git ls-files: {error}"))?;

    if !output.status.success() {
        return Err(format!("git ls-files failed with status {}", output.status));
    }

    Ok(output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
        .map(|path| PathBuf::from(String::from_utf8_lossy(path).into_owned()))
        .collect())
}

fn check_raw_control_bytes() -> bool {
    let files = match tracked_files() {
        Ok(files) => files,
        Err(error) => {
            eprintln!("{error}");
            return false;
        }
    };

    let mut violations = Vec::new();
    let mut read_errors = Vec::new();

    for path in files {
        if !should_scan_for_raw_control_bytes(&path) {
            continue;
        }

        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) => {
                read_errors.push(format!("{}: {error}", path.display()));
                continue;
            }
        };

        if !metadata.file_type().is_file() {
            continue;
        }

        match fs::read(&path) {
            Ok(bytes) => {
                if let Some(control) = first_raw_control_byte(&bytes) {
                    violations.push((path, control));
                }
            }
            Err(error) => read_errors.push(format!("{}: {error}", path.display())),
        }
    }

    if read_errors.is_empty() && violations.is_empty() {
        println!("No raw control bytes found in tracked source text.");
        return true;
    }

    for error in read_errors {
        eprintln!("Failed to read tracked source text file: {error}");
    }

    for (path, control) in violations {
        eprintln!(
            "{}:{}:{}: raw control byte 0x{:02X}; use the \\u escape instead of a literal control character",
            path.display(),
            control.line,
            control.column,
            control.byte
        );
    }

    false
}

fn cmd_clippy() {
    println!("Running clippy...");
    println!();

    // Match the build/dev entry points: raw cargo will fail in runtimed's
    // build.rs when gitignored renderer-plugin artifacts are absent.
    ensure_build_artifacts();

    // Exclude runtimed-py to avoid the pyo3/maturin compile cost locally.
    // CI covers it in the runtimed-py-integration job.
    // Also exclude notebook (needs bundled sidecar binaries) and WASM crates
    // (need wasm-pack), matching CI's clippy-and-tests job.
    if !run_cmd_ok(
        "cargo",
        &[
            "clippy",
            "--workspace",
            "--exclude",
            "runtimed-py",
            "--exclude",
            "notebook",
            "--exclude",
            "runtimed-wasm",
            "--exclude",
            "sift-wasm",
            "--all-targets",
            "--",
            "-D",
            "warnings",
        ],
    ) {
        exit(1);
    }

    println!();
    println!("Clippy passed!");
}

/// Run a command and return true if it succeeded.
fn run_cmd_ok(cmd: &str, args: &[&str]) -> bool {
    let mut command = Command::new(cmd);
    command.args(args);
    if cmd == "cargo" {
        apply_build_channel_env(&mut command);
    }

    command.status().map(|s| s.success()).unwrap_or_else(|e| {
        eprintln!("Failed to run {cmd}: {e}");
        false
    })
}

/// Build external binaries (runtimed daemon and runt CLI) for Tauri bundling.
/// If `release` is true, builds in release mode (for distribution).
/// If `release` is false, builds in debug mode (faster for development).
fn build_runtimed_daemon(release: bool) {
    build_external_binary("runtimed", "runtimed", release);
    build_external_binary("runt", "runt", release);
    build_external_binary("nteract-mcp", "nteract-mcp", release);
}

/// Build a binary and copy to binaries/ with target triple suffix for Tauri bundling.
/// If `release` is true, builds in release mode. Otherwise builds in debug mode.
fn build_external_binary(package: &str, binary_name: &str, release: bool) {
    let mode = if release { "release" } else { "debug" };
    println!("Building {binary_name} ({mode})...");

    // Build with appropriate profile
    if release {
        run_cmd("cargo", &["build", "--release", "-p", package]);
    } else {
        run_cmd("cargo", &["build", "-p", package]);
    }

    copy_sidecar_binary(binary_name, release);
}

/// Copy an already-built binary to the sidecar locations for Tauri bundling.
/// Copies to both `crates/notebook/binaries/` (for bundle builds) and
/// the resolved debug profile's `binaries/` dir (for no-bundle dev builds).
fn copy_sidecar_binary(binary_name: &str, release: bool) {
    let target = get_host_target();
    let profile = if release { "release" } else { "debug" };
    let source = cargo_binary_path(profile, binary_name);

    let dest_name = if cfg!(windows) {
        format!("{binary_name}-{target}.exe")
    } else {
        format!("{binary_name}-{target}")
    };

    // Copy to crates/notebook/binaries/ for Tauri bundle builds
    let binaries_dir = Path::new("crates/notebook/binaries");
    let dest = binaries_dir.join(&dest_name);
    fs::copy(&source, &dest).unwrap_or_else(|e| {
        eprintln!(
            "Failed to copy {binary_name} binary from {}: {e}",
            source.display()
        );
        exit(1);
    });
    println!("{binary_name} ready: {}", dest.display());

    // Also copy to the debug profile's binaries/ for development (no-bundle builds)
    // Tauri's externalBin only copies to app bundle, not for --no-bundle
    let dev_binaries_dir = cargo_profile_dir("debug").join("binaries");
    fs::create_dir_all(&dev_binaries_dir).ok();
    let dev_dest = dev_binaries_dir.join(&dest_name);
    fs::copy(&source, &dev_dest).unwrap_or_else(|e| {
        eprintln!("Failed to copy {binary_name} to dev binaries: {e}");
        exit(1);
    });
    println!("{binary_name} dev ready: {}", dev_dest.display());
}

/// Get the host target triple (e.g., aarch64-apple-darwin).
#[allow(clippy::expect_used)] // xtask is a dev tool; rustc must be available
fn get_host_target() -> String {
    let output = Command::new("rustc")
        .args(["--print", "host-tuple"])
        .output()
        .expect("Failed to get host target from rustc");

    String::from_utf8(output.stdout)
        .expect("Invalid UTF-8 from rustc")
        .trim()
        .to_string()
}

fn run_cmd(cmd: &str, args: &[&str]) {
    let mut command = Command::new(cmd);
    command.args(args);
    if cmd == "cargo" {
        apply_build_channel_env(&mut command);
    }
    if cmd == "wasm-pack" {
        strip_rustc_wrapper_for_wasm(&mut command);
        ensure_wasm_c_toolchain(&mut command);
    }

    let status = command.status().unwrap_or_else(|e| {
        eprintln!("Failed to run {cmd}: {e}");
        exit(1);
    });

    if !status.success() {
        eprintln!("Command failed: {cmd} {}", args.join(" "));
        exit(status.code().unwrap_or(1));
    }
}

fn run_wasm_pack(needs_c_toolchain: bool, cmd: &str, args: &[&str]) {
    let mut command = Command::new(cmd);
    command.args(args);
    strip_rustc_wrapper_for_wasm(&mut command);
    if needs_c_toolchain {
        ensure_wasm_c_toolchain(&mut command);
    }

    let status = command.status().unwrap_or_else(|e| {
        eprintln!("Failed to run {cmd}: {e}");
        exit(1);
    });

    if !status.success() {
        eprintln!("Command failed: {cmd} {}", args.join(" "));
        exit(status.code().unwrap_or(1));
    }
}

/// Probe the gitignored wasm + renderer-plugin outputs and rebuild the
/// affected artifacts when anything is missing or stale.
///
/// Called from the top of every entry point that compiles `runtimed`,
/// `notebook`, or runs the dev daemon, so a fresh clone can go straight to
/// `cargo xtask build` / `dev` / `dev-daemon` / `notebook` without an
/// explicit `cargo xtask artifacts ensure ...` step. `runtimed`'s `build.rs`
/// panics with a scoped `cargo xtask artifacts ensure ...` recovery command if
/// you bypass xtask and invoke `cargo build` directly.
/// Make sure build artifacts on disk match the current source tree.
///
/// Two tiers, matching each artifact's churn profile:
///
/// - **Volatile wasm** (`runtimed-wasm`, `sift-wasm`) is fingerprinted against
///   its workspace source inputs, the relevant Cargo.lock package closure, and
///   required wasm-pack outputs. We rebuild when outputs are missing, invalid,
///   or stale, but skip source-unchanged runs so wasm-pack does not rewrite
///   generated files and invalidate `runtimed` / `notebook` build scripts.
///
/// - **Renderer plugin bundles** split into stable LFS-tracked third-party
///   outputs (`plotly.js`, `vega.js`, `leaflet.*`) and generated local outputs
///   (`isolated-renderer.*`, `markdown.*`, `bokeh.js`, `panel.js`, `sift.*`). We rebuild generated
///   outputs when they're missing or pointer-shaped, and rebuild sift when it
///   is stale relative to sift-wasm source.
///
/// Staleness gate: hash sift-wasm source (`crates/sift-wasm/src/**/*.rs`
/// plus `Cargo.toml`) and compare against the previous run's fingerprint
/// stored under `target/xtask/`. The earlier "did the glue bytes change?"
/// check was a false positive each time wasm-pack regenerated the glue
/// with the same source but slightly different internal metadata, which
/// constantly re-emitted LFS-tracked renderer bundles and surfaced as phantom
/// git dirt.
fn ensure_build_artifacts() {
    let sift_wasm_rebuilt = ensure_volatile_wasm_current();
    ensure_renderer_artifacts_current(sift_wasm_rebuilt);
}

fn ensure_renderer_artifacts_current(sift_wasm_rebuilt: bool) {
    let notebook_plugin_dir = Path::new("apps/notebook/src/renderer-plugins");
    let lfs_tracked_probes = ["plotly.js", "vega.js", "leaflet.js", "leaflet.css"];
    let generated_probes = [
        "isolated-renderer.js",
        "isolated-renderer.css",
        "markdown.js",
        "markdown.css",
        "bokeh.js",
        "panel.js",
    ];
    let missing_lfs_tracked: Vec<&str> = lfs_tracked_probes
        .iter()
        .copied()
        .filter(|p| !notebook_plugin_dir.join(p).exists())
        .collect();
    let unhydrated_lfs_tracked: Vec<&str> = lfs_tracked_probes
        .iter()
        .copied()
        .filter(|p| is_git_lfs_pointer_file(&notebook_plugin_dir.join(p)))
        .collect();
    let generated_needs_rebuild: Vec<&str> = generated_probes
        .iter()
        .copied()
        .filter(|p| {
            let path = notebook_plugin_dir.join(p);
            !path.exists() || is_git_lfs_pointer_file(&path)
        })
        .collect();
    let sift_missing = !notebook_plugin_dir.join("sift.js").exists()
        || !notebook_plugin_dir.join("sift.css").exists();

    if !unhydrated_lfs_tracked.is_empty() {
        eprintln!("Stable renderer plugin bundles are Git LFS pointers:");
        for p in &unhydrated_lfs_tracked {
            eprintln!("  - apps/notebook/src/renderer-plugins/{p}");
        }
        eprintln!("Run `git lfs pull` to hydrate LFS-tracked bundles before building.");
        exit(1);
    }

    let sift_source_fingerprint = sift_wasm_source_fingerprint();
    let stored_fingerprint = read_renderer_plugins_fingerprint();
    let sift_source_changed = match (&sift_source_fingerprint, &stored_fingerprint) {
        (Some(current), Some(prev)) => current != prev,
        // Missing the cached fingerprint means we haven't recorded a
        // successful build under this checkout yet. Don't rebuild on that
        // alone — LFS-tracked bundles are already on disk for fresh checkouts,
        // and generated isolated-renderer outputs are checked above. Persist
        // the current fingerprint below so future runs have a baseline.
        (Some(_), None) => false,
        _ => false,
    };

    if !missing_lfs_tracked.is_empty()
        || !generated_needs_rebuild.is_empty()
        || sift_missing
        || sift_source_changed
        || sift_wasm_rebuilt
    {
        if !missing_lfs_tracked.is_empty() {
            println!("LFS-tracked renderer plugin bundles missing; rebuilding:");
            for p in &missing_lfs_tracked {
                println!("  - apps/notebook/src/renderer-plugins/{p}");
            }
            println!(
                "(If these should already be on disk, run `git lfs pull` to hydrate LFS-tracked bundles.)"
            );
        }
        if !generated_needs_rebuild.is_empty() {
            println!("Generated renderer plugin bundles missing or stale; rebuilding:");
            for p in &generated_needs_rebuild {
                println!("  - apps/notebook/src/renderer-plugins/{p}");
            }
        } else if sift_missing {
            println!("[xtask] sift renderer bundle missing; rebuilding sift renderer plugin");
        } else if sift_source_changed {
            println!(
                "[xtask] sift-wasm source changed; rebuilding sift renderer plugin so sift.js re-embeds the fresh __wbg_* names"
            );
        } else if sift_wasm_rebuilt {
            println!(
                "[xtask] sift-wasm rebuilt; rebuilding sift renderer plugin so sift.js re-embeds the fresh __wbg_* names"
            );
        }
        if !missing_lfs_tracked.is_empty() {
            cmd_renderer_plugins(&[]);
        } else {
            let mut targets = Vec::new();
            if generated_needs_rebuild
                .iter()
                .any(|p| p.starts_with("isolated-renderer."))
            {
                targets.push("isolated-renderer");
            }
            if generated_needs_rebuild
                .iter()
                .any(|p| p.starts_with("markdown."))
            {
                targets.push("markdown");
            }
            if generated_needs_rebuild.contains(&"bokeh.js") {
                targets.push("bokeh");
            }
            if generated_needs_rebuild.contains(&"panel.js") {
                targets.push("panel");
            }
            if sift_missing || sift_source_changed || sift_wasm_rebuilt {
                targets.push("sift");
            }
            cmd_renderer_plugins(&targets);
        }
    }

    if let Some(fp) = sift_source_fingerprint {
        write_renderer_plugins_fingerprint(&fp);
    }
}

const RUNTIMED_WASM_OUTPUTS: &[&str] = &[
    "apps/notebook/src/wasm/runtimed-wasm/package.json",
    "apps/notebook/src/wasm/runtimed-wasm/runtimed_wasm.d.ts",
    "apps/notebook/src/wasm/runtimed-wasm/runtimed_wasm.js",
    "apps/notebook/src/wasm/runtimed-wasm/runtimed_wasm_bg.wasm",
];

const RUNTIMED_WASM_INPUTS: &[&str] = &[
    "Cargo.lock",
    "Cargo.toml",
    "crates/runtimed-wasm/Cargo.toml",
    "crates/runtimed-wasm/src",
    "crates/automerge-recovery/Cargo.toml",
    "crates/automerge-recovery/src",
    "crates/automunge/Cargo.toml",
    "crates/automunge/src",
    "crates/comments-doc/Cargo.toml",
    "crates/comments-doc/assets",
    "crates/comments-doc/src",
    "crates/notebook-doc/Cargo.toml",
    "crates/notebook-doc/assets",
    "crates/notebook-doc/src",
    "crates/notebook-wire/Cargo.toml",
    "crates/notebook-wire/src",
    "crates/nteract-markdown-engine/Cargo.toml",
    "crates/nteract-markdown-engine/src",
    "crates/nteract-markdown-wasm/Cargo.toml",
    "crates/nteract-markdown-wasm/src",
    "crates/nteract-identity/Cargo.toml",
    "crates/nteract-identity/src",
    "crates/runtime-doc/Cargo.toml",
    "crates/runtime-doc/assets",
    "crates/runtime-doc/src",
];

const RUNTIMED_WASM_LOCK_ROOTS: &[&str] = &["runtimed-wasm"];
const RUNTIMED_WASM_FINGERPRINT: &str = "target/xtask/runtimed-wasm.fingerprint";

const SIFT_WASM_OUTPUTS: &[&str] = &[
    "crates/sift-wasm/pkg/package.json",
    "crates/sift-wasm/pkg/sift_wasm.d.ts",
    "crates/sift-wasm/pkg/sift_wasm.js",
    "crates/sift-wasm/pkg/sift_wasm_bg.wasm",
    "packages/sift/public/wasm/package.json",
    "packages/sift/public/wasm/sift_wasm.d.ts",
    "packages/sift/public/wasm/sift_wasm.js",
    "packages/sift/public/wasm/sift_wasm_bg.wasm",
];

const SIFT_WASM_INPUTS: &[&str] = &[
    "Cargo.lock",
    "Cargo.toml",
    "crates/sift-wasm/Cargo.toml",
    "crates/sift-wasm/src",
    "crates/nteract-predicate/Cargo.toml",
    "crates/nteract-predicate/src",
];

const SIFT_WASM_LOCK_ROOTS: &[&str] = &["sift-wasm"];
const SIFT_WASM_FINGERPRINT: &str = "target/xtask/sift-wasm.fingerprint";

const LFS_RENDERER_PLUGIN_OUTPUTS: &[&str] = &[
    "apps/notebook/src/renderer-plugins/plotly.js",
    "apps/notebook/src/renderer-plugins/vega.js",
    "apps/notebook/src/renderer-plugins/leaflet.js",
    "apps/notebook/src/renderer-plugins/leaflet.css",
];

const GENERATED_RENDERER_PLUGIN_OUTPUTS: &[&str] = &[
    "apps/notebook/src/renderer-plugins/isolated-renderer.js",
    "apps/notebook/src/renderer-plugins/isolated-renderer.css",
    "apps/notebook/src/renderer-plugins/markdown.js",
    "apps/notebook/src/renderer-plugins/markdown.css",
    "apps/notebook/src/renderer-plugins/bokeh.js",
    "apps/notebook/src/renderer-plugins/panel.js",
    "apps/notebook/src/renderer-plugins/sift.js",
    "apps/notebook/src/renderer-plugins/sift.css",
];

const RENDERER_PLUGIN_OUTPUTS: &[&str] = &[
    "apps/notebook/src/renderer-plugins/isolated-renderer.js",
    "apps/notebook/src/renderer-plugins/isolated-renderer.css",
    "apps/notebook/src/renderer-plugins/markdown.js",
    "apps/notebook/src/renderer-plugins/markdown.css",
    "apps/notebook/src/renderer-plugins/bokeh.js",
    "apps/notebook/src/renderer-plugins/panel.js",
    "apps/notebook/src/renderer-plugins/plotly.js",
    "apps/notebook/src/renderer-plugins/vega.js",
    "apps/notebook/src/renderer-plugins/leaflet.js",
    "apps/notebook/src/renderer-plugins/leaflet.css",
    "apps/notebook/src/renderer-plugins/sift.js",
    "apps/notebook/src/renderer-plugins/sift.css",
];

const MCP_WIDGET_OUTPUTS: &[&str] = &[
    "crates/runt-mcp/assets/_output.html",
    "python/nteract/src/nteract/_widget.html",
];

/// Ensure gitignored wasm-pack outputs are current enough for regular
/// build/dev commands without rewriting them on every run.
///
/// Explicit `cargo xtask wasm` remains the full rebuild command. This guard is
/// for hot iteration paths, where no-op wasm-pack runs touch generated files
/// and force `runtimed`/`notebook` recompiles through build-script inputs.
fn ensure_volatile_wasm_current() -> bool {
    ensure_workspace_root_cwd();
    ensure_runtimed_wasm_current();
    ensure_sift_wasm_current()
}

fn ensure_sift_wasm_current() -> bool {
    ensure_wasm_package_current(
        "sift-wasm",
        SIFT_WASM_OUTPUTS,
        SIFT_WASM_INPUTS,
        SIFT_WASM_LOCK_ROOTS,
        Path::new(SIFT_WASM_FINGERPRINT),
        || None,
        || cmd_wasm(Some("sift"), true),
    )
}

fn ensure_runtimed_wasm_current() -> bool {
    ensure_wasm_package_current(
        "runtimed-wasm",
        RUNTIMED_WASM_OUTPUTS,
        RUNTIMED_WASM_INPUTS,
        RUNTIMED_WASM_LOCK_ROOTS,
        Path::new(RUNTIMED_WASM_FINGERPRINT),
        || {
            if genesis_seeds_embedded(false) {
                None
            } else {
                Some("genesis seeds changed")
            }
        },
        || cmd_wasm(Some("runtimed"), true),
    )
}

fn ensure_wasm_package_current(
    label: &str,
    outputs: &[&str],
    inputs: &[&str],
    lock_roots: &[&str],
    fingerprint_path: &Path,
    extra_reason: impl FnOnce() -> Option<&'static str>,
    rebuild: impl FnOnce(),
) -> bool {
    let current_fingerprint = wasm_input_fingerprint(inputs, lock_roots);
    let reason = wasm_package_rebuild_reason(
        label,
        outputs,
        inputs,
        fingerprint_path,
        current_fingerprint.as_deref(),
        extra_reason,
    );

    if let Some(reason) = reason {
        println!("[xtask] rebuilding {label} ({reason})");
        rebuild();
        if let Some(fingerprint) = current_fingerprint {
            write_fingerprint(fingerprint_path, &fingerprint);
        }
        true
    } else {
        if let Some(fingerprint) = current_fingerprint {
            write_fingerprint(fingerprint_path, &fingerprint);
        }
        println!("[xtask] skipping {label} rebuild (outputs are up to date)");
        false
    }
}

fn verify_wasm_package_current(
    label: &str,
    outputs: &[&str],
    inputs: &[&str],
    lock_roots: &[&str],
    fingerprint_path: &Path,
    extra_reason: impl FnOnce() -> Option<&'static str>,
) -> bool {
    let current_fingerprint = wasm_input_fingerprint(inputs, lock_roots);
    let reason = wasm_package_verify_reason(
        outputs,
        fingerprint_path,
        current_fingerprint.as_deref(),
        extra_reason,
    );

    if let Some(reason) = reason {
        eprintln!("::error::{label} prebuilt artifacts are not current ({reason})");
        false
    } else {
        println!("[xtask] verified {label} prebuilt artifacts");
        true
    }
}

fn wasm_package_rebuild_reason(
    label: &str,
    outputs: &[&str],
    inputs: &[&str],
    fingerprint_path: &Path,
    current_fingerprint: Option<&str>,
    extra_reason: impl FnOnce() -> Option<&'static str>,
) -> Option<&'static str> {
    for output in outputs {
        if !Path::new(output).exists() {
            return Some("output file missing");
        }
    }

    for output in outputs.iter().filter(|output| output.ends_with(".wasm")) {
        match fs::read(output) {
            Ok(bytes) if bytes.starts_with(b"\0asm") => {}
            Ok(_) => return Some("wasm output is not a WebAssembly binary"),
            Err(_) => return Some("could not read wasm output"),
        }
    }

    if let Some(reason) = extra_reason() {
        return Some(reason);
    }

    let Some(current_fingerprint) = current_fingerprint else {
        return Some("could not fingerprint input files");
    };

    if let Some(previous) = read_fingerprint(fingerprint_path) {
        if previous == current_fingerprint {
            return None;
        }
        return Some("input files changed");
    }

    match inputs_newer_than_outputs(inputs, outputs) {
        Some(true) => Some("input files are newer than outputs"),
        Some(false) => None,
        None => {
            eprintln!("[xtask] warning: could not compare {label} input/output timestamps");
            Some("could not compare input/output timestamps")
        }
    }
}

fn wasm_package_verify_reason(
    outputs: &[&str],
    fingerprint_path: &Path,
    current_fingerprint: Option<&str>,
    extra_reason: impl FnOnce() -> Option<&'static str>,
) -> Option<&'static str> {
    for output in outputs {
        if !Path::new(output).exists() {
            return Some("output file missing");
        }
    }

    for output in outputs.iter().filter(|output| output.ends_with(".wasm")) {
        match fs::read(output) {
            Ok(bytes) if bytes.starts_with(b"\0asm") => {}
            Ok(_) => return Some("wasm output is not a WebAssembly binary"),
            Err(_) => return Some("could not read wasm output"),
        }
    }

    if let Some(reason) = extra_reason() {
        return Some(reason);
    }

    let Some(current_fingerprint) = current_fingerprint else {
        return Some("could not fingerprint input files");
    };

    match read_fingerprint(fingerprint_path) {
        Some(previous) if previous == current_fingerprint => None,
        Some(_) => Some("input files changed"),
        None => Some("input fingerprint missing"),
    }
}

fn wasm_input_fingerprint(paths: &[&str], lock_roots: &[&str]) -> Option<String> {
    let mut files = Vec::new();
    for path in paths {
        let path = Path::new(path);
        if path.is_dir() {
            collect_files_recursive(path, &mut files);
        } else if path.is_file() {
            files.push(path.to_path_buf());
        } else {
            return None;
        }
    }
    sort_fingerprint_paths(&mut files);

    let mut hasher = StableHasher::new();
    for path in &files {
        if path.file_name().and_then(|name| name.to_str()) == Some("Cargo.lock")
            && !lock_roots.is_empty()
        {
            hash_filtered_cargo_lock(path, lock_roots, &mut hasher)?;
        } else {
            hash_path_and_bytes(path, &fs::read(path).ok()?, &mut hasher);
        }
    }
    Some(hasher.finish_hex())
}

fn collect_files_recursive(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_files_recursive(&path, out);
        } else if path.is_file() {
            out.push(path);
        }
    }
}

struct StableHasher {
    state: u64,
}

impl StableHasher {
    const OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
    const PRIME: u64 = 0x0000_0100_0000_01b3;

    fn new() -> Self {
        Self {
            state: Self::OFFSET,
        }
    }

    fn write(&mut self, bytes: &[u8]) {
        for byte in bytes {
            self.state ^= u64::from(*byte);
            self.state = self.state.wrapping_mul(Self::PRIME);
        }
    }

    fn write_str(&mut self, value: &str) {
        self.write(value.as_bytes());
        self.write(&[0]);
    }

    fn finish_hex(&self) -> String {
        format!("{:016x}", self.state)
    }
}

fn hash_path_and_bytes(path: &Path, bytes: &[u8], hasher: &mut StableHasher) {
    hasher.write_str(&normalize_fingerprint_path(path));
    if should_normalize_fingerprint_line_endings(path) {
        hasher.write(&normalize_crlf_line_endings(bytes));
    } else {
        hasher.write(bytes);
    }
    hasher.write(&[0xff]);
}

fn normalize_fingerprint_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn sort_fingerprint_paths(paths: &mut [PathBuf]) {
    paths.sort_by_key(|path| normalize_fingerprint_path(path));
}

fn should_normalize_fingerprint_line_endings(path: &Path) -> bool {
    if path.file_name().and_then(|name| name.to_str()) == Some("Cargo.lock") {
        return true;
    }
    matches!(
        path.extension().and_then(|extension| extension.to_str()),
        Some("rs" | "toml")
    )
}

fn normalize_crlf_line_endings(bytes: &[u8]) -> Vec<u8> {
    let mut normalized = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\r' && bytes.get(i + 1) == Some(&b'\n') {
            normalized.push(b'\n');
            i += 2;
        } else {
            normalized.push(bytes[i]);
            i += 1;
        }
    }
    normalized
}

#[derive(Debug)]
struct LockPackage {
    name: String,
    dependencies: Vec<String>,
    block: String,
}

fn hash_filtered_cargo_lock(
    path: &Path,
    root_names: &[&str],
    hasher: &mut StableHasher,
) -> Option<()> {
    let contents = fs::read(path).ok()?;
    let contents = String::from_utf8(normalize_crlf_line_endings(&contents)).ok()?;
    let (preamble, packages) = parse_cargo_lock_packages(&contents);
    if packages.is_empty() {
        return None;
    }

    let root_set: HashSet<&str> = root_names.iter().copied().collect();
    if !packages
        .iter()
        .any(|package| root_set.contains(package.name.as_str()))
    {
        return None;
    }

    let mut selected = HashSet::new();
    let mut queue: VecDeque<String> = root_names.iter().map(|name| (*name).to_string()).collect();
    while let Some(name) = queue.pop_front() {
        if !selected.insert(name.clone()) {
            continue;
        }
        for package in packages.iter().filter(|package| package.name == name) {
            for dep in &package.dependencies {
                if !selected.contains(dep) {
                    queue.push_back(dep.clone());
                }
            }
        }
    }

    hasher.write_str(&format!(
        "{}:filtered-lock",
        normalize_fingerprint_path(path)
    ));
    for root in root_names {
        hasher.write_str(root);
    }
    hasher.write_str(preamble);
    for package in packages
        .iter()
        .filter(|package| selected.contains(&package.name))
    {
        hasher.write_str(&package.block);
    }

    Some(())
}

fn parse_cargo_lock_packages(contents: &str) -> (&str, Vec<LockPackage>) {
    let Some(first_package) = contents.find("[[package]]") else {
        return (contents, Vec::new());
    };
    let preamble = &contents[..first_package];
    let mut packages = Vec::new();

    for raw_block in contents[first_package..].split("\n[[package]]") {
        let block = if raw_block.starts_with("[[package]]") {
            raw_block.to_string()
        } else {
            format!("[[package]]{raw_block}")
        };
        let Some(package) = parse_cargo_lock_package(&block) else {
            continue;
        };
        packages.push(package);
    }

    (preamble, packages)
}

fn parse_cargo_lock_package(block: &str) -> Option<LockPackage> {
    let mut name = None;
    let mut dependencies = Vec::new();
    let mut in_dependencies = false;

    for line in block.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("name = ") {
            name = quoted_values(trimmed)
                .into_iter()
                .next()
                .map(str::to_string);
        } else if trimmed.starts_with("dependencies = ") {
            in_dependencies = true;
            dependencies.extend(quoted_values(trimmed).into_iter().map(lock_dependency_name));
            if trimmed.contains(']') {
                in_dependencies = false;
            }
        } else if in_dependencies {
            if trimmed.starts_with(']') {
                in_dependencies = false;
            } else {
                dependencies.extend(quoted_values(trimmed).into_iter().map(lock_dependency_name));
            }
        }
    }

    Some(LockPackage {
        name: name?,
        dependencies,
        block: block.to_string(),
    })
}

fn quoted_values(line: &str) -> Vec<&str> {
    let mut values = Vec::new();
    let mut rest = line;
    while let Some(start) = rest.find('"') {
        let after_start = &rest[start + 1..];
        let Some(end) = after_start.find('"') else {
            break;
        };
        values.push(&after_start[..end]);
        rest = &after_start[end + 1..];
    }
    values
}

fn lock_dependency_name(spec: &str) -> String {
    spec.split_whitespace().next().unwrap_or(spec).to_string()
}

fn inputs_newer_than_outputs(inputs: &[&str], outputs: &[&str]) -> Option<bool> {
    let oldest_output = outputs
        .iter()
        .filter_map(|output| modified_time(Path::new(output)))
        .min()?;

    let mut input_files = Vec::new();
    for input in inputs {
        let path = Path::new(input);
        if path.is_dir() {
            collect_files_recursive(path, &mut input_files);
        } else if path.is_file() {
            input_files.push(path.to_path_buf());
        } else {
            return None;
        }
    }

    for input in input_files {
        if modified_time(&input)? > oldest_output {
            return Some(true);
        }
    }
    Some(false)
}

fn read_fingerprint(path: &Path) -> Option<String> {
    fs::read_to_string(path)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn write_fingerprint(path: &Path, fingerprint: &str) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(path, fingerprint);
}

fn write_wasm_package_fingerprint(label: &str, inputs: &[&str], lock_roots: &[&str], path: &Path) {
    match wasm_input_fingerprint(inputs, lock_roots) {
        Some(fingerprint) => write_fingerprint(path, &fingerprint),
        None => eprintln!("[xtask] warning: could not write {label} fingerprint"),
    }
}

/// Hash every `.rs` file under `crates/sift-wasm/src/` plus its `Cargo.toml`
/// into a single u64. Returns `None` if the directory is missing (fresh
/// pre-clone state — let the missing-files probe handle it).
fn sift_wasm_source_fingerprint() -> Option<String> {
    let root = Path::new("crates/sift-wasm");
    if !root.exists() {
        return None;
    }
    let mut files: Vec<PathBuf> = Vec::new();
    collect_rust_sources(&root.join("src"), &mut files);
    files.push(root.join("Cargo.toml"));
    sort_fingerprint_paths(&mut files);

    let mut hasher = StableHasher::new();
    for path in &files {
        match fs::read(path) {
            Ok(bytes) => {
                hash_path_and_bytes(path, &bytes, &mut hasher);
            }
            Err(_) => return None,
        }
    }
    Some(hasher.finish_hex())
}

fn collect_rust_sources(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_rust_sources(&path, out);
        } else if path.extension().and_then(|s| s.to_str()) == Some("rs") {
            out.push(path);
        }
    }
}

fn renderer_plugins_fingerprint_path() -> PathBuf {
    Path::new("target/xtask").join("renderer-plugins.fingerprint")
}

fn read_renderer_plugins_fingerprint() -> Option<String> {
    fs::read_to_string(renderer_plugins_fingerprint_path())
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn write_renderer_plugins_fingerprint(fingerprint: &str) {
    let path = renderer_plugins_fingerprint_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(&path, fingerprint);
}

fn write_current_renderer_plugins_fingerprint() {
    match sift_wasm_source_fingerprint() {
        Some(fingerprint) => write_renderer_plugins_fingerprint(&fingerprint),
        None => eprintln!("[xtask] warning: could not write renderer plugin fingerprint"),
    }
}

/// Build the MCP Apps widget (apps/mcp-app) and copy it into the Python
/// nteract package so it ships with the PyPI wheel.
fn mcp_widget_needs_rebuild() -> Option<&'static str> {
    // If any output is missing, must rebuild
    let mut oldest_output = None;
    for output in MCP_WIDGET_OUTPUTS {
        let output = Path::new(output);
        if !output.exists() {
            return Some("output file missing");
        }
        if is_mcp_widget_placeholder(output) {
            return Some("placeholder output file");
        }
        let Some(t) = modified_time(output) else {
            return Some("could not read output timestamp");
        };
        oldest_output = Some(match oldest_output {
            None => t,
            Some(prev) => std::cmp::min(prev, t),
        });
    }
    // Safety: we checked all outputs exist above, so oldest_output is always Some
    let Some(oldest_output) = oldest_output else {
        return Some("could not determine output timestamps");
    };

    // Check build scripts, lockfile, and all source files against the oldest output.
    let top_level_sources = [
        Path::new("apps/mcp-app/package.json"),
        Path::new("apps/mcp-app/build-html.js"),
        Path::new("apps/mcp-app/vite.config.ts"),
        Path::new("apps/mcp-app/build-plugins.ts"),
        Path::new("src/build/renderer-plugin-builder.ts"),
        Path::new("apps/notebook/src/renderer-plugins/markdown.js"),
        Path::new("apps/notebook/src/renderer-plugins/markdown.css"),
        Path::new("apps/notebook/src/renderer-plugins/bokeh.js"),
        Path::new("apps/notebook/src/renderer-plugins/panel.js"),
        Path::new("apps/notebook/src/renderer-plugins/plotly.js"),
        Path::new("apps/notebook/src/renderer-plugins/vega.js"),
        Path::new("apps/notebook/src/renderer-plugins/leaflet.js"),
        Path::new("apps/notebook/src/renderer-plugins/leaflet.css"),
        Path::new("apps/notebook/src/renderer-plugins/sift.js"),
        Path::new("apps/notebook/src/renderer-plugins/sift.css"),
        Path::new("crates/sift-wasm/pkg/sift_wasm_bg.wasm"),
        Path::new("pnpm-lock.yaml"),
    ];
    for src in &top_level_sources {
        if let Some(src_time) = modified_time(src) {
            if src_time > oldest_output {
                return Some("source files changed");
            }
        }
    }
    // Walk all files under apps/mcp-app/src/
    if let Ok(entries) = std::fs::read_dir("apps/mcp-app/src") {
        fn check_dir_recursive(dir: std::fs::ReadDir, threshold: std::time::SystemTime) -> bool {
            for entry in dir.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    if let Ok(sub) = std::fs::read_dir(&path) {
                        if check_dir_recursive(sub, threshold) {
                            return true;
                        }
                    }
                } else if let Some(t) = modified_time(&path) {
                    if t > threshold {
                        return true;
                    }
                }
            }
            false
        }
        if check_dir_recursive(entries, oldest_output) {
            return Some("source files changed");
        }
    }

    None
}

fn is_mcp_widget_placeholder(path: &Path) -> bool {
    fs::read_to_string(path)
        .map(|contents| {
            contents.contains("Placeholder")
                && contents.contains("cargo xtask build")
                && contents.contains("generate the real output renderer")
        })
        .unwrap_or(false)
}

fn build_mcp_widget() {
    if let Some(reason) = mcp_widget_needs_rebuild() {
        println!("Building MCP Apps widget ({reason})...");
        require_pnpm();
        ensure_pnpm_install();
        run_pnpm(&["exec", "vp", "run", "nteract-mcp-app#build"]);
        let dest = Path::new("python/nteract/src/nteract/_widget.html");
        if !dest.exists() {
            eprintln!("Error: MCP widget build did not produce _widget.html");
            exit(1);
        }
        println!("MCP Apps widget built successfully");
    } else {
        println!("Skipping MCP Apps widget build (outputs are up to date).");
    }
}

fn run_frontend_build(debug_bundle: bool) {
    ensure_build_artifacts();
    let pnpm = resolve_pnpm_command_or_exit();
    let args = ["build"];
    let mut command = pnpm.command();
    command.args(args);
    if debug_bundle {
        command.env("RUNT_NOTEBOOK_DEBUG_BUILD", "1");
    }

    let status = command.status().unwrap_or_else(|e| {
        eprintln!("Failed to run {}: {e}", pnpm.display_with_args(&args));
        exit(1);
    });

    if !status.success() {
        eprintln!("Command failed: {}", pnpm.display_with_args(&args));
        exit(status.code().unwrap_or(1));
    }
}

fn strip_rustc_wrapper_for_wasm(command: &mut Command) {
    if env::var_os("RUSTC_WRAPPER").is_some() {
        eprintln!(
            "Note: stripping RUSTC_WRAPPER for wasm-pack \
             (sccache/mold/etc. break wasm32 C builds)"
        );
        command.env_remove("RUSTC_WRAPPER");
    }
}

/// Point `cc-rs` at a clang that knows about `wasm32-unknown-unknown`.
///
/// `zstd-sys` (pulled in by `parquet` with the `zstd` feature, which we need
/// to read pandas/duckdb/spark parquet in `sift-wasm`) compiles C for
/// `wasm32-unknown-unknown`. Apple's Xcode clang has no wasm backend —
/// `clang --print-targets` lists only AArch64/ARM/x86 — so the build fails
/// with `'No available targets are compatible with triple "wasm32-unknown-unknown"'`.
/// Homebrew's `llvm` formula ships a clang that does have wasm32/wasm64
/// registered; we detect it and point `cc-rs` at it via the per-target
/// env vars it honors.
///
/// Order:
///   1. If the user already set `CC_wasm32_unknown_unknown` (or the dashed
///      variant), honor it and do nothing.
///   2. Probe known brew prefixes then `clang` on PATH, picking the first
///      whose `--print-targets` mentions `wasm32`.
///   3. If nothing qualifies, bail with install instructions. We do NOT
///      run `brew install` — that's the user's call.
fn ensure_wasm_c_toolchain(command: &mut Command) {
    if env::var_os("CC_wasm32_unknown_unknown").is_some()
        || env::var_os("CC_wasm32-unknown-unknown").is_some()
    {
        return;
    }

    let candidates = [
        "/opt/homebrew/opt/llvm/bin/clang",
        "/usr/local/opt/llvm/bin/clang",
        "clang",
    ];

    for candidate in candidates {
        if !clang_supports_wasm32(candidate) {
            continue;
        }
        command.env("CC_wasm32_unknown_unknown", candidate);
        if let Some(ar) = sibling_llvm_ar(candidate) {
            command.env("AR_wasm32_unknown_unknown", ar);
        }
        eprintln!(
            "Note: using {candidate} as CC_wasm32_unknown_unknown \
             (Xcode clang has no wasm backend)"
        );
        return;
    }

    eprintln!(
        "Error: no clang with a wasm32 backend was found.\n\
         \n\
         zstd-sys (via parquet's `zstd` feature in sift-wasm) cross-compiles\n\
         C to wasm32-unknown-unknown. Apple's Xcode clang does not register\n\
         the wasm32 target, so the build fails with:\n\
         \n\
           'No available targets are compatible with triple \"wasm32-unknown-unknown\"'\n\
         \n\
         Fix (macOS): install Homebrew LLVM, which ships a clang with the\n\
         wasm32 backend:\n\
         \n\
           brew install llvm\n\
         \n\
         Or, if LLVM is already installed elsewhere, point cc-rs at it:\n\
         \n\
           export CC_wasm32_unknown_unknown=/path/to/clang\n\
           export AR_wasm32_unknown_unknown=/path/to/llvm-ar"
    );
    exit(1);
}

fn clang_supports_wasm32(clang: &str) -> bool {
    let output = Command::new(clang)
        .arg("--print-targets")
        .stderr(Stdio::null())
        .output();
    match output {
        Ok(out) if out.status.success() => String::from_utf8_lossy(&out.stdout).contains("wasm32"),
        _ => false,
    }
}

fn sibling_llvm_ar(clang: &str) -> Option<PathBuf> {
    let path = Path::new(clang);
    let dir = path.parent()?;
    let ar = dir.join("llvm-ar");
    ar.exists().then_some(ar)
}

fn apply_rust_log_env(command: &mut Command) {
    let rust_log = env::var("RUST_LOG").unwrap_or_else(|_| "info".to_string());
    command.env("RUST_LOG", rust_log);
}

fn apply_build_channel_env(command: &mut Command) {
    let build_channel = env::var("RUNT_BUILD_CHANNEL")
        .unwrap_or_else(|_| runt_workspace::channel_display_name().to_string());
    command.env("RUNT_BUILD_CHANNEL", build_channel);
}

fn apply_worktree_env(command: &mut Command, force_dev_mode: bool) {
    if force_dev_mode {
        command.env("RUNTIMED_DEV", "1");
    }

    if let Ok(path) = env::var("CONDUCTOR_WORKSPACE_PATH") {
        command.env("RUNTIMED_WORKSPACE_PATH", path);
    } else if force_dev_mode {
        if let Some(path) = runt_workspace::get_workspace_path() {
            command.env("RUNTIMED_WORKSPACE_PATH", path);
        }
    }
}

fn exit_on_failed_status(label: &str, status: ExitStatus) {
    if !status.success() {
        eprintln!("{label} exited with status {status}");
        exit(status.code().unwrap_or(1));
    }
}

/// Package nteract as a Claude Desktop extension (.mcpb ZIP archive).
///
/// The bundle contains:
///   manifest.json   — metadata and server entry point
///   icon.png        — 512×512 light-theme icon
///   icon-dark.png   — 512×512 dark-theme icon
///
/// The server is NOT bundled as a binary. Instead the manifest includes a
/// Node launcher script that finds the `runt` (or `runt-nightly`) binary
/// on the user's PATH or in well-known install locations, then execs
/// `runt mcp` for stdio transport.
///
/// Manifest templates live in `mcpb/manifest.{variant}.json`. The only
/// substitution is `{{VERSION}}` → the `runtimed` crate version.
fn cmd_mcpb(output: Option<&str>, variant: &str) {
    let version = read_package_version("runtimed");

    // ── 1. Read and populate the manifest template ──────────────────────────
    let template_path = format!("mcpb/manifest.{variant}.json");
    let template = fs::read_to_string(&template_path).unwrap_or_else(|e| {
        eprintln!("Failed to read {template_path}: {e}");
        eprintln!("Valid variants: stable, nightly (looked for mcpb/manifest.{{variant}}.json)");
        exit(1);
    });

    let manifest_str = template.replace("{{VERSION}}", &version);

    // Parse to validate JSON and re-serialize with consistent formatting.
    let manifest: serde_json::Value = serde_json::from_str(&manifest_str).unwrap_or_else(|e| {
        eprintln!("Invalid JSON in {template_path} after substitution: {e}");
        exit(1);
    });
    let manifest_str = serde_json::to_string_pretty(&manifest).unwrap_or_else(|e| {
        eprintln!("Failed to serialize manifest.json: {e}");
        exit(1);
    });

    // ── 2. Create a staging directory ───────────────────────────────────────
    let staging_dir = std::env::temp_dir().join(format!("nteract-mcpb-{}", std::process::id()));
    fs::create_dir_all(&staging_dir).unwrap_or_else(|e| {
        eprintln!("Failed to create staging directory: {e}");
        exit(1);
    });

    // ── 3. Copy icons ────────────────────────────────────────────────────────
    // Stable: light = source.png, dark = source-nightly.png
    // Nightly: light = source-nightly.png, dark = source.png (swapped)
    let (light_src, dark_src) = match variant {
        "nightly" => (
            "crates/notebook/icons/source-nightly.png",
            "crates/notebook/icons/source.png",
        ),
        _ => (
            "crates/notebook/icons/source.png",
            "crates/notebook/icons/source-nightly.png",
        ),
    };

    if !Path::new(light_src).exists() {
        eprintln!("Icon not found: {light_src}");
        eprintln!("Run `cargo xtask icons` first to generate icons.");
        let _ = fs::remove_dir_all(&staging_dir);
        exit(1);
    }

    // Resize icons to 512x512 — source assets are 1024x1024 but the manifest
    // declares 512x512 and Claude Desktop may be strict about the match.
    let resize_icon = |src: &str, dest: &str| {
        let status = Command::new("sips")
            .args(["-z", "512", "512", src, "--out", dest])
            .stdout(Stdio::null())
            .status()
            .unwrap_or_else(|e| {
                eprintln!("Failed to run sips to resize {src}: {e}");
                exit(1);
            });
        if !status.success() {
            eprintln!("sips failed to resize {src}");
            exit(1);
        }
    };

    let light_dest = staging_dir.join("icon.png");
    resize_icon(light_src, &light_dest.to_string_lossy());

    // If the dark icon doesn't exist, fall back to the light icon.
    let dark_actual = if Path::new(dark_src).exists() {
        dark_src
    } else {
        light_src
    };
    let dark_dest = staging_dir.join("icon-dark.png");
    resize_icon(dark_actual, &dark_dest.to_string_lossy());

    // ── 4. Build and copy nteract-mcp binary ────────────────────────────────
    // Set RUNT_BUILD_CHANNEL so the binary knows its channel at compile time.
    let build_channel = match variant {
        "stable" => "stable",
        _ => "nightly",
    };
    println!("Building nteract-mcp (release, channel={build_channel})...");
    let mut build_cmd = Command::new("cargo");
    build_cmd.args(["build", "-p", "nteract-mcp", "--release"]);
    build_cmd.env("RUNT_BUILD_CHANNEL", build_channel);
    let build_status = build_cmd.status().unwrap_or_else(|e| {
        eprintln!("Failed to run cargo build -p nteract-mcp: {e}");
        exit(1);
    });
    if !build_status.success() {
        eprintln!("cargo build -p nteract-mcp --release failed");
        let _ = fs::remove_dir_all(&staging_dir);
        exit(1);
    }

    let binary_name = if cfg!(target_os = "windows") {
        "nteract-mcp.exe"
    } else {
        "nteract-mcp"
    };
    let built_binary = cargo_binary_path("release", "nteract-mcp");
    if !built_binary.exists() {
        eprintln!("Built binary not found at {}", built_binary.display());
        let _ = fs::remove_dir_all(&staging_dir);
        exit(1);
    }

    let server_dir = staging_dir.join("server");
    fs::create_dir_all(&server_dir).unwrap_or_else(|e| {
        eprintln!("Failed to create server directory: {e}");
        exit(1);
    });
    fs::copy(&built_binary, server_dir.join(binary_name)).unwrap_or_else(|e| {
        eprintln!("Failed to copy nteract-mcp binary: {e}");
        exit(1);
    });

    // Strip the binary on Unix to minimize bundle size
    #[cfg(unix)]
    {
        let strip_target = server_dir.join(binary_name);
        let _ = Command::new("strip").arg(&strip_target).status();
    }

    // ── 5. Write manifest.json ──────────────────────────────────────────────
    fs::write(staging_dir.join("manifest.json"), &manifest_str).unwrap_or_else(|e| {
        eprintln!("Failed to write manifest.json: {e}");
        exit(1);
    });

    // ── 6. Create ZIP archive ────────────────────────────────────────────────
    let default_name = if variant == "stable" {
        "nteract.mcpb"
    } else {
        "nteract-nightly.mcpb"
    };
    let output_path = output.unwrap_or(default_name);

    // Resolve the output path to an absolute path before changing directories.
    let abs_output = if Path::new(output_path).is_absolute() {
        Path::new(output_path).to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|e| {
                eprintln!("Failed to get current directory: {e}");
                exit(1);
            })
            .join(output_path)
    };

    // Ensure the parent directory exists so zip can create the output file.
    if let Some(parent) = abs_output.parent() {
        fs::create_dir_all(parent).unwrap_or_else(|e| {
            eprintln!(
                "Failed to create output directory {}: {e}",
                parent.display()
            );
            exit(1);
        });
    }

    // Remove any existing archive so zip doesn't merge old contents.
    let _ = fs::remove_file(&abs_output);

    println!("Creating archive {}...", abs_output.display());

    let zip_status = Command::new("zip")
        .args(["-r", &abs_output.to_string_lossy(), "."])
        .current_dir(&staging_dir)
        .status()
        .unwrap_or_else(|e| {
            eprintln!("Failed to run zip: {e}");
            eprintln!("zip must be available in PATH.");
            exit(1);
        });

    if !zip_status.success() {
        eprintln!("zip command failed");
        let _ = fs::remove_dir_all(&staging_dir);
        exit(1);
    }

    // ── 7. Cleanup staging dir ───────────────────────────────────────────────
    let _ = fs::remove_dir_all(&staging_dir);

    println!("Done: {}", abs_output.display());
}

/// Read the version of a workspace package from `cargo metadata`.
fn read_package_version(package: &str) -> String {
    let output = Command::new("cargo")
        .args(["metadata", "--no-deps", "--format-version", "1"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .unwrap_or_else(|e| {
            eprintln!("Failed to run cargo metadata: {e}");
            exit(1);
        });

    if !output.status.success() {
        eprintln!("cargo metadata failed");
        exit(1);
    }

    let metadata: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap_or_else(|e| {
        eprintln!("Failed to parse cargo metadata output: {e}");
        exit(1);
    });

    metadata["packages"]
        .as_array()
        .and_then(|pkgs| pkgs.iter().find(|p| p["name"].as_str() == Some(package)))
        .and_then(|p| p["version"].as_str())
        .unwrap_or("0.0.0")
        .to_string()
}

const TOOL_DESC_BYTE_BUDGET: usize = 1500;

#[allow(clippy::expect_used)]
fn cmd_sync_tool_cache(check: bool) {
    let tool_cache_path = Path::new("crates/runt-mcp-proxy/tool-cache.json");
    let manifest_nightly = Path::new("mcpb/manifest.nightly.json");
    let manifest_stable = Path::new("mcpb/manifest.stable.json");

    eprintln!("Building runt (release)...");
    run_cmd("cargo", &["build", "--release", "-p", "runt"]);

    eprintln!("Dumping tool list from runt mcp...");
    let runt_bin = cargo_binary_path("release", "runt");
    let tools_json = dump_mcp_tools(&runt_bin);

    // 3. Parse and compute description bytes
    let tools: serde_json::Value = serde_json::from_str(&tools_json)
        .unwrap_or_else(|e| panic!("Failed to parse tool list: {e}"));
    let tools_arr = tools.as_array().expect("tools should be an array");

    let total_desc_bytes: usize = tools_arr
        .iter()
        .filter_map(|t| t["description"].as_str())
        .map(|d| d.len())
        .sum();

    eprintln!(
        "  {} tools, {} description bytes (budget: {})",
        tools_arr.len(),
        total_desc_bytes,
        TOOL_DESC_BYTE_BUDGET
    );

    if total_desc_bytes > TOOL_DESC_BYTE_BUDGET {
        eprintln!(
            "ERROR: Tool description bytes ({}) exceed budget ({})",
            total_desc_bytes, TOOL_DESC_BYTE_BUDGET
        );
        if check {
            exit(1);
        } else {
            eprintln!("  (continuing anyway since --check was not passed)");
        }
    }

    // 4. Format the built-in tool cache JSON. The live child can advertise
    // richer metadata such as inline icon data; the checked-in fallback cache
    // intentionally stays compact because it is only used until the child is
    // ready and emits tools/list_changed.
    let cache_tools = strip_tool_icons_for_builtin_cache(tools_arr);
    let formatted =
        serde_json::to_string_pretty(&cache_tools).expect("Failed to format tool cache");

    if check {
        // Check mode: compare against existing files
        let mut stale = false;

        let existing_cache = fs::read_to_string(tool_cache_path).unwrap_or_default();
        if existing_cache.trim() != formatted.trim() {
            eprintln!("STALE: {}", tool_cache_path.display());
            stale = true;
        }

        for manifest_path in [&manifest_nightly, &manifest_stable] {
            let existing = fs::read_to_string(manifest_path).unwrap_or_default();
            let updated = update_manifest_tools(&existing, tools_arr);
            if existing.trim() != updated.trim() {
                eprintln!("STALE: {}", manifest_path.display());
                stale = true;
            }
        }

        // Also check mcpb_install.rs descriptions match
        let mcpb_install = Path::new("crates/notebook/src/mcpb_install.rs");
        if mcpb_install.exists() {
            let source = fs::read_to_string(mcpb_install).unwrap_or_default();
            for tool in tools_arr {
                let name = tool["name"].as_str().unwrap_or("");
                let desc = tool["description"].as_str().unwrap_or("");
                // The mcpb_install.rs source is Rust code with JSON inside a
                // serde_json::json!() macro, so inner quotes appear as \"
                // in the source file. Escape them in the needle to match.
                let escaped_desc = desc.replace('"', r#"\""#);
                let needle = format!(r#""description": "{}""#, escaped_desc);
                if !source.contains(&needle) && source.contains(&format!(r#""name": "{}""#, name)) {
                    eprintln!(
                        "STALE: {} (description mismatch for tool '{}')",
                        mcpb_install.display(),
                        name
                    );
                    stale = true;
                    break;
                }
            }
        }

        if stale {
            eprintln!();
            eprintln!("Run `cargo xtask sync-tool-cache` to fix JSON caches.");
            eprintln!("If mcpb_install.rs is stale, update it manually to match.");
            exit(1);
        }
        eprintln!("All tool caches are up to date.");
    } else {
        // Write mode: update files
        fs::write(tool_cache_path, &formatted)
            .unwrap_or_else(|e| panic!("Failed to write {}: {e}", tool_cache_path.display()));
        eprintln!("  Updated {}", tool_cache_path.display());

        for manifest_path in [&manifest_nightly, &manifest_stable] {
            let existing = fs::read_to_string(manifest_path).unwrap_or_default();
            let updated = update_manifest_tools(&existing, tools_arr);
            fs::write(manifest_path, &updated)
                .unwrap_or_else(|e| panic!("Failed to write {}: {e}", manifest_path.display()));
            eprintln!("  Updated {}", manifest_path.display());
        }

        eprintln!("Done. Review the changes and commit.");
    }
}

fn strip_tool_icons_for_builtin_cache(tools: &[serde_json::Value]) -> Vec<serde_json::Value> {
    tools
        .iter()
        .map(|tool| {
            let mut tool = tool.clone();
            if let Some(object) = tool.as_object_mut() {
                object.remove("icons");
            }
            tool
        })
        .collect()
}

#[allow(clippy::expect_used)]
fn dump_mcp_tools(runt_bin: &Path) -> String {
    use std::io::{Read, Write};

    let mut child = Command::new(runt_bin)
        .arg("mcp")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("Failed to spawn runt mcp");

    let stdin = child.stdin.as_mut().expect("stdin");
    let init_msg = r#"{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"xtask","version":"1.0"}}}"#;
    writeln!(stdin, "{}", init_msg).ok();
    thread::sleep(Duration::from_secs(1));

    let list_msg = r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#;
    writeln!(stdin, "{}", list_msg).ok();
    thread::sleep(Duration::from_secs(1));
    drop(child.stdin.take());

    let mut output = String::new();
    child
        .stdout
        .as_mut()
        .expect("stdout")
        .read_to_string(&mut output)
        .ok();
    child.kill().ok();
    child.wait().ok();

    for line in output.lines() {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
            if let Some(tools) = v.get("result").and_then(|r| r.get("tools")) {
                return serde_json::to_string(tools).expect("serialize tools");
            }
        }
    }
    panic!("Failed to get tools/list response from runt mcp");
}

#[allow(clippy::expect_used)]
fn update_manifest_tools(manifest_json: &str, tools: &[serde_json::Value]) -> String {
    let mut manifest: serde_json::Value =
        serde_json::from_str(manifest_json).expect("parse manifest");

    let tool_entries: Vec<serde_json::Value> = tools
        .iter()
        .map(|t| {
            serde_json::json!({
                "name": t["name"],
                "description": t["description"]
            })
        })
        .collect();

    manifest["tools"] = serde_json::Value::Array(tool_entries);

    let mut buf = serde_json::to_string_pretty(&manifest).expect("format manifest");
    buf.push('\n');
    buf
}

fn cmd_check_dep_budget() {
    ensure_workspace_root_cwd();

    // Budgets are unique crate counts (deduplicated, excluding the root crate).
    const BUDGETS: &[(&str, usize)] = &[
        ("xtask", 30),
        ("runt-workspace", 35),
        ("runt-trust", 50),
        ("notebook-doc", 110),
        ("kernel-launch", 175),
        ("runtimed-client", 310),
    ];

    println!("{:<20} {:>5}  {:>6}  Status", "Crate", "Deps", "Budget");

    let mut any_over = false;

    for &(crate_name, budget) in BUDGETS {
        let output = Command::new("cargo")
            .args(["tree", "-e", "normal", "--prefix", "none", "-p", crate_name])
            .output()
            .unwrap_or_else(|e| {
                eprintln!("Failed to run cargo tree for {crate_name}: {e}");
                exit(1);
            });

        if !output.status.success() {
            eprintln!(
                "cargo tree failed for {crate_name}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            exit(1);
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut seen = std::collections::HashSet::new();
        let mut count = 0usize;
        for line in stdout.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            // Strip trailing (*) duplicate markers
            let line = line.trim_end_matches(" (*)").trim();
            // Use the crate name + version (first two tokens) as the dedup key
            let key: String = line
                .split_whitespace()
                .take(2)
                .collect::<Vec<_>>()
                .join(" ");
            if seen.insert(key) {
                count += 1;
            }
        }
        // Subtract the root crate itself
        count = count.saturating_sub(1);

        let (status, over) = if count > budget {
            (format!("\u{2717} OVER BUDGET (+{})", count - budget), true)
        } else {
            ("\u{2713}".to_string(), false)
        };

        println!("{:<20} {:>5}  {:>6}  {}", crate_name, count, budget, status);

        if over {
            any_over = true;
        }
    }

    if any_over {
        eprintln!();
        eprintln!("One or more crates exceed their dependency budget.");
        exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    #[test]
    fn parse_dev_options_reads_flags_and_path() {
        let args = vec![
            "dev".to_string(),
            "--skip-install".to_string(),
            "notebooks/demo.ipynb".to_string(),
            "--skip-build".to_string(),
        ];

        let options = parse_dev_options(&args);
        assert_eq!(
            options,
            DevOptions {
                notebook: Some("notebooks/demo.ipynb"),
                skip_install: true,
                skip_build: true,
            }
        );
    }

    #[test]
    fn parse_pnpm_package_manager_version_accepts_pnpm_specs() {
        assert_eq!(
            parse_pnpm_package_manager_version("pnpm@10.30.0").unwrap(),
            "10.30.0"
        );
        assert_eq!(
            parse_pnpm_package_manager_version("pnpm@10.30.0+sha512.test").unwrap(),
            "10.30.0"
        );
    }

    #[test]
    fn parse_pnpm_package_manager_version_rejects_non_pnpm_specs() {
        assert!(parse_pnpm_package_manager_version("npm@11.0.0").is_err());
        assert!(parse_pnpm_package_manager_version("pnpm@").is_err());
    }

    #[test]
    fn choose_pnpm_source_prefers_matching_corepack_over_wrong_direct_pnpm() {
        let corepack = Ok("10.30.0".to_string());
        let direct = Ok("11.7.0".to_string());

        assert_eq!(
            choose_pnpm_source("10.30.0", &corepack, &direct),
            Some(PnpmSource::Corepack)
        );
    }

    #[test]
    fn choose_pnpm_source_accepts_direct_pnpm_only_when_it_matches_pin() {
        let corepack = Err("failed to start: corepack not found".to_string());
        let direct = Ok("10.30.0".to_string());

        assert_eq!(
            choose_pnpm_source("10.30.0", &corepack, &direct),
            Some(PnpmSource::Direct)
        );
    }

    #[test]
    fn choose_pnpm_source_rejects_mismatched_versions() {
        let corepack = Err("failed to start: corepack not found".to_string());
        let direct = Ok("11.7.0".to_string());

        assert_eq!(choose_pnpm_source("10.30.0", &corepack, &direct), None);
    }

    #[test]
    fn last_non_empty_line_uses_final_version_line() {
        assert_eq!(
            last_non_empty_line(b"Preparing pnpm...\n10.30.0\n"),
            Some("10.30.0".to_string())
        );
    }

    #[test]
    fn raw_control_byte_detector_allows_common_whitespace() {
        assert_eq!(first_raw_control_byte(b"alpha\tbeta\r\ngamma"), None);
    }

    #[test]
    fn raw_control_byte_detector_reports_literal_control_bytes() {
        assert_eq!(
            first_raw_control_byte(b"alpha\nbe\0ta"),
            Some(RawControlByte {
                byte: 0,
                offset: 8,
                line: 2,
                column: 3,
            })
        );
        assert_eq!(
            first_raw_control_byte(b"alpha\x1fbeta").map(|control| control.byte),
            Some(0x1f)
        );
    }

    #[test]
    fn raw_control_byte_path_filter_scans_source_not_generated_bundles() {
        assert!(should_scan_for_raw_control_bytes(Path::new(
            "apps/notebook/src/App.tsx"
        )));
        assert!(should_scan_for_raw_control_bytes(Path::new(
            ".github/workflows/build.yml"
        )));
        assert!(should_scan_for_raw_control_bytes(Path::new("Cargo.lock")));
        assert!(!should_scan_for_raw_control_bytes(Path::new(
            "crates/comments-doc/assets/comments_doc_genesis_v1.am"
        )));
        assert!(!should_scan_for_raw_control_bytes(Path::new(
            "apps/notebook/src/renderer-plugins/plotly.js"
        )));
    }

    #[test]
    fn parse_renderer_plugin_targets_defaults_to_all() {
        let args: Vec<String> = Vec::new();
        assert!(parse_renderer_plugin_targets(&args).is_empty());
    }

    #[test]
    fn parse_renderer_plugin_targets_reads_repeated_and_csv_only_flags() {
        let args = vec![
            "--only".to_string(),
            "sift, markdown".to_string(),
            "--only=isolated-renderer".to_string(),
        ];

        assert_eq!(
            parse_renderer_plugin_targets(&args),
            vec![
                "sift".to_string(),
                "markdown".to_string(),
                "isolated-renderer".to_string()
            ]
        );
    }

    #[test]
    fn parse_artifact_command_defaults_to_status_all() {
        assert_eq!(
            parse_artifact_command(&[]),
            ArtifactCommand {
                action: ArtifactAction::Status,
                scopes: ALL_ARTIFACT_SCOPES.to_vec(),
            }
        );
    }

    #[test]
    fn parse_artifact_command_reads_action_and_deduped_scopes() {
        let args = vec![
            "verify".to_string(),
            "renderer,sift".to_string(),
            "renderer".to_string(),
            "mcp-widget".to_string(),
        ];

        assert_eq!(
            parse_artifact_command(&args),
            ArtifactCommand {
                action: ArtifactAction::Verify,
                scopes: vec![
                    ArtifactScope::Renderer,
                    ArtifactScope::Sift,
                    ArtifactScope::McpWidget,
                ],
            }
        );
    }

    #[test]
    fn parse_artifact_command_accepts_scope_without_action_as_status() {
        let args = vec!["runtime".to_string(), "renderer-plugins".to_string()];

        assert_eq!(
            parse_artifact_command(&args),
            ArtifactCommand {
                action: ArtifactAction::Status,
                scopes: vec![ArtifactScope::Runtime, ArtifactScope::Renderer],
            }
        );
    }

    #[test]
    fn generated_artifact_shape_checks_detect_lfs_pointers_and_mcp_placeholders() {
        let dir = test_temp_dir("artifact-shape");
        fs::create_dir_all(&dir).expect("create temp dir");
        let lfs = dir.join("plotly.js");
        let widget = dir.join("_output.html");
        fs::write(
            &lfs,
            "version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 1\n",
        )
        .expect("write lfs pointer");
        fs::write(
            &widget,
            "<!doctype html><p>Placeholder - run <code>cargo xtask build</code> to generate the real output renderer.</p>",
        )
        .expect("write placeholder");

        assert!(is_git_lfs_pointer_file(&lfs));
        assert!(is_mcp_widget_placeholder(&widget));

        fs::remove_dir_all(dir).expect("remove temp dir");
    }

    #[test]
    fn renderer_plugin_targets_include_sift_for_full_or_sift_builds() {
        assert!(renderer_plugin_targets_include_sift(&[]));
        assert!(renderer_plugin_targets_include_sift(&["sift"]));
        assert!(renderer_plugin_targets_include_sift(&["markdown", "sift"]));
        assert!(!renderer_plugin_targets_include_sift(&["markdown"]));
        assert!(!renderer_plugin_targets_include_sift(&[
            "isolated-renderer"
        ]));
    }

    #[test]
    fn fingerprint_path_sort_uses_normalized_separators() {
        let mut paths = vec![PathBuf::from("src/a0.rs"), PathBuf::from(r"src\a\z.rs")];
        sort_fingerprint_paths(&mut paths);

        let normalized: Vec<String> = paths
            .iter()
            .map(|path| normalize_fingerprint_path(path))
            .collect();
        assert_eq!(normalized, vec!["src/a/z.rs", "src/a0.rs"]);
    }

    #[test]
    fn wasm_package_rebuild_reason_rejects_missing_or_invalid_outputs() {
        let dir = test_temp_dir("wasm-missing-invalid");
        fs::create_dir_all(&dir).expect("create temp dir");
        let input = dir.join("input.rs");
        let output = dir.join("out.wasm");
        let stamp = dir.join("stamp");
        fs::write(&input, "fn main() {}").expect("write input");

        let inputs = [input.to_string_lossy().to_string()];
        let outputs = [output.to_string_lossy().to_string()];
        let input_refs: Vec<&str> = inputs.iter().map(String::as_str).collect();
        let output_refs: Vec<&str> = outputs.iter().map(String::as_str).collect();

        assert_eq!(
            wasm_package_rebuild_reason(
                "test-wasm",
                &output_refs,
                &input_refs,
                &stamp,
                wasm_input_fingerprint(&input_refs, &[]).as_deref(),
                || None,
            ),
            Some("output file missing")
        );

        fs::write(&output, "not wasm").expect("write invalid wasm");
        assert_eq!(
            wasm_package_rebuild_reason(
                "test-wasm",
                &output_refs,
                &input_refs,
                &stamp,
                wasm_input_fingerprint(&input_refs, &[]).as_deref(),
                || None,
            ),
            Some("wasm output is not a WebAssembly binary")
        );

        fs::remove_dir_all(dir).expect("remove temp dir");
    }

    #[test]
    fn wasm_package_rebuild_reason_uses_input_fingerprint() {
        let dir = test_temp_dir("wasm-fingerprint");
        fs::create_dir_all(&dir).expect("create temp dir");
        let input = dir.join("input.rs");
        let output = dir.join("out.wasm");
        let stamp = dir.join("stamp");
        fs::write(&input, "pub fn exported() {}").expect("write input");
        fs::write(&output, b"\0asmcurrent").expect("write wasm");

        let inputs = [input.to_string_lossy().to_string()];
        let outputs = [output.to_string_lossy().to_string()];
        let input_refs: Vec<&str> = inputs.iter().map(String::as_str).collect();
        let output_refs: Vec<&str> = outputs.iter().map(String::as_str).collect();
        let fingerprint = wasm_input_fingerprint(&input_refs, &[]).expect("fingerprint input");

        assert_eq!(
            wasm_package_rebuild_reason(
                "test-wasm",
                &output_refs,
                &input_refs,
                &stamp,
                Some(&fingerprint),
                || None,
            ),
            None
        );

        fs::write(&stamp, "stale").expect("write stale stamp");
        assert_eq!(
            wasm_package_rebuild_reason(
                "test-wasm",
                &output_refs,
                &input_refs,
                &stamp,
                Some(&fingerprint),
                || None,
            ),
            Some("input files changed")
        );

        fs::write(&stamp, &fingerprint).expect("write current stamp");
        assert_eq!(
            wasm_package_rebuild_reason(
                "test-wasm",
                &output_refs,
                &input_refs,
                &stamp,
                Some(&fingerprint),
                || None,
            ),
            None
        );

        set_modified_time(&output, UNIX_EPOCH + Duration::from_secs(1));
        set_modified_time(&input, UNIX_EPOCH + Duration::from_secs(2));
        assert_eq!(
            wasm_package_rebuild_reason(
                "test-wasm",
                &output_refs,
                &input_refs,
                &stamp,
                Some(&fingerprint),
                || None,
            ),
            None
        );

        fs::remove_dir_all(dir).expect("remove temp dir");
    }

    #[test]
    fn wasm_package_verify_reason_requires_current_fingerprint() {
        let dir = test_temp_dir("wasm-verify-fingerprint");
        fs::create_dir_all(&dir).expect("create temp dir");
        let input = dir.join("input.rs");
        let output = dir.join("out.wasm");
        let stamp = dir.join("stamp");
        fs::write(&input, "pub fn exported() {}").expect("write input");
        fs::write(&output, b"\0asmcurrent").expect("write wasm");

        let inputs = [input.to_string_lossy().to_string()];
        let outputs = [output.to_string_lossy().to_string()];
        let input_refs: Vec<&str> = inputs.iter().map(String::as_str).collect();
        let output_refs: Vec<&str> = outputs.iter().map(String::as_str).collect();
        let fingerprint = wasm_input_fingerprint(&input_refs, &[]).expect("fingerprint input");

        assert_eq!(
            wasm_package_verify_reason(&output_refs, &stamp, Some(&fingerprint), || None),
            Some("input fingerprint missing")
        );

        fs::write(&stamp, "stale").expect("write stale stamp");
        assert_eq!(
            wasm_package_verify_reason(&output_refs, &stamp, Some(&fingerprint), || None),
            Some("input files changed")
        );

        fs::write(&stamp, &fingerprint).expect("write current stamp");
        set_modified_time(&output, UNIX_EPOCH + Duration::from_secs(1));
        set_modified_time(&input, UNIX_EPOCH + Duration::from_secs(2));
        assert_eq!(
            wasm_package_verify_reason(&output_refs, &stamp, Some(&fingerprint), || None),
            None
        );

        fs::remove_dir_all(dir).expect("remove temp dir");
    }

    #[test]
    fn wasm_input_fingerprint_filters_unrelated_cargo_lock_packages() {
        let dir = test_temp_dir("wasm-lock-filter");
        fs::create_dir_all(&dir).expect("create temp dir");
        let lock = dir.join("Cargo.lock");
        let source = dir.join("input.rs");
        fs::write(&source, "pub fn exported() {}").expect("write input");

        let base_lock = r#"# This file is automatically @generated by Cargo.
version = 4

[[package]]
name = "root-wasm"
version = "0.1.0"
dependencies = [
 "dep-a",
]

[[package]]
name = "dep-a"
version = "1.0.0"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "aaa"

[[package]]
name = "unrelated"
version = "1.0.0"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "old"
"#;
        fs::write(&lock, base_lock).expect("write lock");
        let inputs = [
            lock.to_string_lossy().to_string(),
            source.to_string_lossy().to_string(),
        ];
        let input_refs: Vec<&str> = inputs.iter().map(String::as_str).collect();
        let first = wasm_input_fingerprint(&input_refs, &["root-wasm"]).expect("fingerprint");

        fs::write(&lock, base_lock.replace('\n', "\r\n")).expect("write crlf lock");
        let crlf =
            wasm_input_fingerprint(&input_refs, &["root-wasm"]).expect("fingerprint unchanged");
        assert_eq!(first, crlf);

        fs::write(
            &lock,
            base_lock.replace("checksum = \"old\"", "checksum = \"new\""),
        )
        .expect("write unrelated lock change");
        let unrelated =
            wasm_input_fingerprint(&input_refs, &["root-wasm"]).expect("fingerprint unchanged");
        assert_eq!(first, unrelated);

        fs::write(
            &lock,
            base_lock.replace("checksum = \"aaa\"", "checksum = \"bbb\""),
        )
        .expect("write related lock change");
        let related =
            wasm_input_fingerprint(&input_refs, &["root-wasm"]).expect("fingerprint changed");
        assert_ne!(first, related);

        fs::remove_dir_all(dir).expect("remove temp dir");
    }

    #[test]
    fn wasm_fingerprint_normalizes_text_paths_and_line_endings() {
        let mut unix_text = StableHasher::new();
        hash_path_and_bytes(
            Path::new("crates/runtimed-wasm/src/lib.rs"),
            b"pub fn demo() {}\n",
            &mut unix_text,
        );

        let mut windows_text = StableHasher::new();
        hash_path_and_bytes(
            Path::new(r"crates\runtimed-wasm\src\lib.rs"),
            b"pub fn demo() {}\r\n",
            &mut windows_text,
        );

        assert_eq!(unix_text.finish_hex(), windows_text.finish_hex());

        let mut unix_binary = StableHasher::new();
        hash_path_and_bytes(
            Path::new("crates/notebook-doc/assets/notebook_genesis_v5.am"),
            b"seed\r\n",
            &mut unix_binary,
        );

        let mut windows_binary = StableHasher::new();
        hash_path_and_bytes(
            Path::new(r"crates\notebook-doc\assets\notebook_genesis_v5.am"),
            b"seed\n",
            &mut windows_binary,
        );

        assert_ne!(unix_binary.finish_hex(), windows_binary.finish_hex());
    }

    fn test_temp_dir(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time after epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("{name}-{}-{unique}", std::process::id()))
    }

    fn set_modified_time(path: &Path, timestamp: SystemTime) {
        let file = fs::OpenOptions::new()
            .write(true)
            .open(path)
            .expect("open file to set modified time");
        file.set_times(fs::FileTimes::new().set_modified(timestamp))
            .expect("set modified time");
    }

    #[test]
    fn pi_passthrough_only_for_management_and_metadata_commands() {
        let cases = [
            (&[][..], false),
            (&["--help"][..], true),
            (&["-h"][..], true),
            (&["--version"][..], true),
            (&["-v"][..], true),
            (&["install"][..], true),
            (&["remove"][..], true),
            (&["uninstall"][..], true),
            (&["update"][..], true),
            (&["list"][..], true),
            (&["config"][..], true),
            (&["-p", "exit"][..], false),
            (&["run"][..], false),
            (&["--extension", "other.ts"][..], false),
        ];

        for (args, expected) in cases {
            let args: Vec<String> = args.iter().map(|arg| arg.to_string()).collect();
            assert_eq!(pi_passthrough_without_extension(&args), expected);
        }
    }

    #[test]
    fn default_vite_port_is_stable_for_workspace() {
        let workspace = Path::new("/workspace/example");
        let port = runt_workspace::vite_port_for_workspace(workspace);
        assert_eq!(port, runt_workspace::vite_port_for_workspace(workspace));
        assert!((5100u16..10000u16).contains(&port));
    }

    #[test]
    fn freshness_reason_requires_stamp() {
        let watched = [Some(UNIX_EPOCH + Duration::from_secs(5))];
        assert_eq!(
            freshness_reason(None, watched),
            Some("missing develop stamp")
        );
    }

    #[test]
    fn freshness_reason_detects_newer_sources() {
        let stamp = UNIX_EPOCH + Duration::from_secs(5);
        let watched = [Some(UNIX_EPOCH + Duration::from_secs(6))];
        assert_eq!(
            freshness_reason(Some(stamp), watched),
            Some("binding sources changed")
        );
    }

    #[test]
    fn freshness_reason_detects_missing_timestamps() {
        let stamp = UNIX_EPOCH + Duration::from_secs(5);
        let watched = [None];
        assert_eq!(
            freshness_reason(Some(stamp), watched),
            Some("could not read binding source timestamps")
        );
    }

    #[test]
    fn freshness_reason_skips_when_stamp_is_newer() {
        let stamp = UNIX_EPOCH + Duration::from_secs(10);
        let watched = [
            Some(UNIX_EPOCH + Duration::from_secs(5)),
            Some(UNIX_EPOCH + Duration::from_secs(9)),
        ];
        assert_eq!(freshness_reason(Some(stamp), watched), None);
    }

    #[test]
    fn bytes_contain_matches_subsequences() {
        let hay = b"the genesis seed lives here";
        assert!(bytes_contain(hay, b"genesis seed"));
        assert!(bytes_contain(hay, b"the")); // at start
        assert!(bytes_contain(hay, b"here")); // at end
        assert!(bytes_contain(hay, hay)); // whole haystack
        assert!(!bytes_contain(hay, b"absent"));
        assert!(!bytes_contain(hay, b"")); // empty needle never matches
        assert!(!bytes_contain(b"short", b"this needle is longer"));
        // First-byte match but full sequence differs.
        assert!(!bytes_contain(b"abcabd", b"abce"));
        assert!(bytes_contain(b"abcabd", b"abd"));
    }

    #[test]
    fn built_in_tool_cache_strips_inline_icons() {
        let tools = vec![serde_json::json!({
            "name": "create_cell",
            "description": "Create a cell.",
            "icons": [
                {
                    "src": "data:image/png;base64,abc",
                    "mimeType": "image/png",
                    "sizes": ["96x96"],
                    "theme": "light"
                }
            ]
        })];

        let stripped = strip_tool_icons_for_builtin_cache(&tools);

        assert_eq!(stripped.len(), 1);
        assert_eq!(stripped[0]["name"], "create_cell");
        assert!(stripped[0].get("icons").is_none());
    }

    /// Build a minimal wasm module with an import section. Used to exercise
    /// `parse_wasm_bindgen_imports` without depending on a real wasm-pack
    /// artifact.
    fn encode_uleb128(mut value: u64) -> Vec<u8> {
        let mut out = Vec::new();
        loop {
            let mut byte = (value & 0x7f) as u8;
            value >>= 7;
            if value != 0 {
                byte |= 0x80;
                out.push(byte);
            } else {
                out.push(byte);
                return out;
            }
        }
    }

    fn make_import_section(imports: &[(&str, &str)]) -> Vec<u8> {
        let mut body = encode_uleb128(imports.len() as u64);
        for (module, name) in imports {
            body.extend(encode_uleb128(module.len() as u64));
            body.extend_from_slice(module.as_bytes());
            body.extend(encode_uleb128(name.len() as u64));
            body.extend_from_slice(name.as_bytes());
            // import kind 0x00 (func) + type index 0
            body.push(0x00);
            body.extend(encode_uleb128(0));
        }
        let mut out = vec![0x02]; // section id = 2 (Import)
        out.extend(encode_uleb128(body.len() as u64));
        out.extend(body);
        out
    }

    fn make_wasm(imports: &[(&str, &str)]) -> Vec<u8> {
        let mut out = Vec::from(b"\0asm\x01\0\0\0" as &[u8]);
        out.extend(make_import_section(imports));
        out
    }

    #[test]
    fn parse_wasm_bindgen_imports_rejects_non_wasm() {
        assert!(parse_wasm_bindgen_imports(b"not a wasm file").is_err());
    }

    #[test]
    fn parse_wasm_bindgen_imports_returns_only_wasm_bindgen_names() {
        let wasm = make_wasm(&[
            ("./sift_wasm_bg.js", "__wbg_Error_abc123"),
            ("./sift_wasm_bg.js", "__wbindgen_throw"),
            ("env", "memory"), // non-wbg import, should be filtered
            ("./sift_wasm_bg.js", "__wbg_new_xyz789"),
        ]);
        let names = parse_wasm_bindgen_imports(&wasm).unwrap();
        assert_eq!(
            names,
            vec!["__wbg_Error_abc123", "__wbindgen_throw", "__wbg_new_xyz789"]
        );
    }

    #[test]
    fn parse_wasm_bindgen_imports_empty_when_no_imports() {
        let wasm = Vec::from(b"\0asm\x01\0\0\0" as &[u8]);
        assert_eq!(
            parse_wasm_bindgen_imports(&wasm).unwrap(),
            Vec::<String>::new()
        );
    }
}
