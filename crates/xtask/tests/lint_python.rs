//! Exercise the actual lint subprocess boundary without running installers or linters.
#![cfg(unix)]
#![allow(clippy::unwrap_used)]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicUsize, Ordering};

static NEXT_ID: AtomicUsize = AtomicUsize::new(0);

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "nteract-lint-python-{}-{}",
            std::process::id(),
            NEXT_ID.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        let fixture = Self(path);
        fixture.script("cargo", "[ \"$1\" = fmt ]");
        fixture.script("git", "[ \"$*\" = 'ls-files -z' ]");
        let package: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../package.json"),
            )
            .unwrap(),
        )
        .unwrap();
        let pnpm_version = package["packageManager"]
            .as_str()
            .unwrap()
            .strip_prefix("pnpm@")
            .unwrap();
        fixture.script(
            "corepack",
            &format!(
                "case \"$*\" in\n\
                 'pnpm --version') echo {pnpm_version} ;;\n\
                 'enable --install-directory '*' pnpm') ;;\n\
                 'pnpm exec vp check'*) printf '%s\\n' \"$PATH\" > \"$PNPM_EXEC_PATH\" ;;\n\
                 *) exit 91 ;;\n\
                 esac"
            ),
        );
        fixture
    }

    fn script(&self, name: &str, body: &str) {
        let path = self.0.join(name);
        fs::write(&path, format!("#!/bin/sh\nset -eu\n{body}\n")).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
    }

    fn lint(&self, fix: bool, no_sync: Option<&str>) -> Output {
        self.lint_from(
            fix,
            no_sync,
            &PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."),
        )
    }

    fn lint_from(&self, fix: bool, no_sync: Option<&str>, directory: &Path) -> Output {
        let mut command = Command::new(env!("CARGO_BIN_EXE_xtask"));
        command
            .arg("lint")
            .current_dir(directory)
            .env("PATH", format!("{}:/usr/bin:/bin", self.0.display()))
            .env("LINT_CALLS", self.0.join("calls"))
            .env("PNPM_EXEC_PATH", self.0.join("pnpm-exec-path"))
            .env(
                "UV_PROJECT_ENVIRONMENT",
                self.0.join("external-environment"),
            )
            .env_remove("UV_NO_SYNC");
        if fix {
            command.arg("--fix");
        }
        if let Some(value) = no_sync {
            command.env("UV_NO_SYNC", value);
        }
        command.output().unwrap()
    }
}

/// A `uv` that records each call with the environment it targets, and
/// accepts the lint environment sync and tool runs.
const RECORDING_UV: &str = "[ \"$1\" = --version ] && exit 0\n\
    printf '%s %s\\n' \"$UV_PROJECT_ENVIRONMENT\" \"$*\" >> \"$LINT_CALLS\"\n\
    case \"$1 $2\" in 'sync --no-install-workspace' | 'run --no-sync') ;; *) exit 2 ;; esac";

const LINT_ENV: &str = "target/xtask/python-lint-env";

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn python_lint_targets_its_own_environment_regardless_of_inherited_env() {
    for no_sync in [None, Some("1"), Some("false")] {
        for fix in [false, true] {
            let fixture = Fixture::new();
            fixture.script("uv", RECORDING_UV);
            let output = fixture.lint(fix, no_sync);
            assert!(output.status.success(), "{output:?}");
            let calls = fs::read_to_string(fixture.0.join("calls")).unwrap();
            let tool_calls: &[&str] = if fix {
                &[
                    "run --no-sync python -I -m ruff check --fix .",
                    "run --no-sync python -I -m ruff format .",
                    "run --no-sync python -I -m ty check python/",
                ]
            } else {
                &[
                    "run --no-sync python -I -m ruff check .",
                    "run --no-sync python -I -m ruff format --check .",
                    "run --no-sync python -I -m ty check python/",
                ]
            };
            let expected: String = std::iter::once(&"sync --no-install-workspace")
                .chain(tool_calls)
                .map(|call| format!("{LINT_ENV} {call}\n"))
                .collect();
            assert_eq!(calls, expected);
        }
    }
}

#[test]
fn failed_environment_sync_is_reported_apart_from_lint_findings() {
    let fixture = Fixture::new();
    fixture.script(
        "uv",
        "[ \"$1\" = --version ] && exit 0\nprintf '%s\\n' \"$1\" >> \"$LINT_CALLS\"\nexit 2",
    );
    let output = fixture.lint(false, None);
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("environment failure"));
    let calls = fs::read_to_string(fixture.0.join("calls")).unwrap();
    assert_eq!(calls, "sync\n", "no tool runs after a failed sync");
}

#[test]
fn failing_python_tool_fails_lint() {
    let fixture = Fixture::new();
    fixture.script("uv", "[ \"$1\" = --version ] || [ \"$1\" = sync ]");
    let output = fixture.lint(false, None);
    assert!(!output.status.success());
    assert!(!String::from_utf8_lossy(&output.stderr).contains("environment failure"));
}

#[test]
fn unavailable_uv_fails_instead_of_skipping_python_lint() {
    let fixture = Fixture::new();
    fixture.script("uv", "exit 127");
    let output = fixture.lint(false, None);
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("Python lint requires uv"));
}

#[test]
fn python_lint_runs_from_a_workspace_member() {
    let fixture = Fixture::new();
    fixture.script("uv", RECORDING_UV);
    let output = fixture.lint_from(false, None, Path::new(env!("CARGO_MANIFEST_DIR")));
    assert!(output.status.success(), "{output:?}");
    let calls = fs::read_to_string(fixture.0.join("calls")).unwrap();
    assert_eq!(calls.lines().count(), 4);
    assert!(calls.contains("-m ruff check ."));
    assert!(calls.contains("-m ty check python/"));
}

#[test]
fn nested_pnpm_resolves_through_corepack_shims() {
    let fixture = Fixture::new();
    fixture.script("uv", RECORDING_UV);
    let output = fixture.lint(false, None);
    assert!(output.status.success(), "{output:?}");
    let path = fs::read_to_string(fixture.0.join("pnpm-exec-path")).unwrap();
    let first = path.trim_end().split(':').next().unwrap();
    assert!(
        first.ends_with("target/xtask/corepack-shims"),
        "shims are not first on PATH: {path}"
    );
}
