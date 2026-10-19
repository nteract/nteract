//! Exercise the actual lint subprocess boundary without running installers or linters.
#![cfg(unix)]
#![allow(clippy::unwrap_used)]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
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
            &format!("case \"$*\" in 'pnpm --version') echo {pnpm_version} ;; 'pnpm exec vp check'*) ;; *) exit 91 ;; esac"),
        );
        fixture
    }

    fn script(&self, name: &str, body: &str) {
        let path = self.0.join(name);
        fs::write(&path, format!("#!/bin/sh\nset -eu\n{body}\n")).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
    }

    fn lint(&self, fix: bool, no_sync: Option<&str>) -> Output {
        let mut command = Command::new(env!("CARGO_BIN_EXE_xtask"));
        command
            .arg("lint")
            .current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."))
            .env("PATH", format!("{}:/usr/bin:/bin", self.0.display()))
            .env("LINT_CALLS", self.0.join("calls"))
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

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn python_lint_never_requests_sync_regardless_of_inherited_env() {
    for no_sync in [None, Some("1"), Some("false")] {
        for fix in [false, true] {
            let fixture = Fixture::new();
            fixture.script(
                "uv",
                "[ \"$1\" = --version ] && exit 0\nprintf '%s\\n' \"$*\" >> \"$LINT_CALLS\"\n[ \"$1\" = run ] && [ \"$2\" = --no-sync ]",
            );
            let output = fixture.lint(fix, no_sync);
            assert!(output.status.success(), "{output:?}");
            let calls = fs::read_to_string(fixture.0.join("calls")).unwrap();
            let expected = if fix {
                "run --no-sync python -I -m ruff check --fix .\nrun --no-sync python -I -m ruff format .\nrun --no-sync python -I -m ty check python/\n"
            } else {
                "run --no-sync python -I -m ruff check .\nrun --no-sync python -I -m ruff format --check .\nrun --no-sync python -I -m ty check python/\n"
            };
            assert_eq!(calls, expected);
        }
    }
}

#[test]
fn missing_python_tool_fails_lint_with_setup_guidance() {
    let fixture = Fixture::new();
    fixture.script("uv", "[ \"$1\" = --version ] && exit 0\nexit 2");
    let output = fixture.lint(false, None);
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("uv sync"));
}

#[test]
fn unavailable_uv_fails_instead_of_skipping_python_lint() {
    let fixture = Fixture::new();
    fixture.script("uv", "exit 127");
    let output = fixture.lint(false, None);
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("uv"));
}
