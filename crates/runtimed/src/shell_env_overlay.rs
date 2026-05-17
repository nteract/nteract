//! Capture the user's login-shell environment once at daemon startup. The
//! daemon's own process env is never modified; the overlay is injected into
//! each `LaunchKernel`/`RestartKernel` RPC's `env_vars` field so the toggle
//! is honored per-launch without a runtime-agent respawn.

use tracing::warn;

#[cfg(unix)]
const CAPTURE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);
#[cfg(unix)]
const SHELL_CAPTURE_SCRIPT: &str = "env -0";

/// Env vars the daemon manages directly on the kernel `Command`. Excluding them
/// from the overlay keeps the user's shell value from redirecting a pooled
/// uv/conda kernel into the wrong Python or clobbering the launcher
/// `PYTHONPATH` the daemon sets in `crates/runtimed/src/jupyter_kernel.rs`.
///
/// Anything not in this list - `PATH`, `HOME`, `ANTHROPIC_API_KEY`, etc. - still
/// flows through to the kernel.
const ACTIVATION_DENYLIST: &[&str] = &[
    "PYTHONPATH",
    "PYTHONHOME",
    "VIRTUAL_ENV",
    "CONDA_PREFIX",
    "CONDA_DEFAULT_ENV",
    "CONDA_PYTHON_EXE",
    "CONDA_EXE",
    "CONDA_SHLVL",
    "PIXI_PROJECT_MANIFEST",
    "PIXI_PROJECT_NAME",
    "PIXI_PROJECT_ROOT",
    "PIXI_PROJECT_VERSION",
    "PIXI_ENVIRONMENT_NAME",
];

#[derive(Debug, Default, Clone)]
pub struct ShellEnvOverlay {
    entries: Vec<(String, String)>,
}

impl ShellEnvOverlay {
    pub fn empty() -> Self {
        Self::default()
    }

    pub fn parse_null_separated(bytes: &[u8]) -> Self {
        let mut entries = Vec::new();
        for chunk in bytes.split(|&b| b == 0) {
            if chunk.is_empty() {
                continue;
            }
            let Some(eq_idx) = chunk.iter().position(|&b| b == b'=') else {
                continue;
            };
            let key_bytes = &chunk[..eq_idx];
            let value_bytes = &chunk[eq_idx + 1..];

            let Ok(key) = std::str::from_utf8(key_bytes) else {
                warn!(
                    "[shell-env-overlay] dropping entry with non-UTF-8 key ({} bytes)",
                    key_bytes.len()
                );
                continue;
            };
            let Ok(value) = std::str::from_utf8(value_bytes) else {
                warn!(
                    "[shell-env-overlay] dropping non-UTF-8 value for key {:?}",
                    key
                );
                continue;
            };
            entries.push((key.to_string(), value.to_string()));
        }
        Self { entries }
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn entries(&self) -> &[(String, String)] {
        &self.entries
    }

    /// Iterate overlay entries with daemon-managed activation keys
    /// (`PYTHONPATH`, `VIRTUAL_ENV`, `CONDA_*`, `PIXI_*`) filtered out. Use
    /// this when injecting the overlay into `LaunchKernel`/`RestartKernel`
    /// `env_vars` - those keys would otherwise overwrite values
    /// `jupyter_kernel.rs` sets per-launch.
    pub fn entries_for_kernel_launch(&self) -> impl Iterator<Item = &(String, String)> {
        self.entries
            .iter()
            .filter(|(k, _)| !ACTIVATION_DENYLIST.contains(&k.as_str()))
    }

    #[cfg(unix)]
    pub fn capture() -> Self {
        match capture_inner() {
            Ok(overlay) => {
                tracing::info!(
                    "[shell-env-overlay] captured {} entries from login shell",
                    overlay.len()
                );
                overlay
            }
            Err(e) => {
                tracing::warn!("[shell-env-overlay] capture failed: {e}; using empty overlay");
                Self::empty()
            }
        }
    }

    #[cfg(not(unix))]
    pub fn capture() -> Self {
        Self::empty()
    }
}

#[cfg(unix)]
fn capture_inner() -> Result<ShellEnvOverlay, String> {
    use std::io::Read;
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};

    let shell = std::env::var_os("SHELL").unwrap_or_else(|| std::ffi::OsString::from("/bin/zsh"));

    let mut cmd = Command::new(&shell);
    cmd.args(["-l", "-c", SHELL_CAPTURE_SCRIPT])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());

    // Put the shell in its own session so a timeout-kill via -pgid tears down
    // any subshells rc files forked. setsid is async-signal-safe per POSIX.
    unsafe {
        cmd.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }

    let mut child = cmd.spawn().map_err(|e| format!("spawn {shell:?}: {e}"))?;
    let pid = child.id() as i32;
    let mut stdout = child.stdout.take().ok_or("missing stdout pipe")?;

    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = Vec::with_capacity(8 * 1024);
        let result = stdout
            .read_to_end(&mut buf)
            .map(|_| buf)
            .map_err(|e| e.to_string());
        let _ = tx.send(result);
    });

    let buf = match rx.recv_timeout(CAPTURE_TIMEOUT) {
        Ok(Ok(buf)) => buf,
        Ok(Err(e)) => {
            kill_group_and_wait(pid, &mut child);
            return Err(format!("read stdout: {e}"));
        }
        Err(_) => {
            kill_group_and_wait(pid, &mut child);
            return Err(format!(
                "login shell capture timed out after {CAPTURE_TIMEOUT:?}"
            ));
        }
    };

    match child.wait() {
        Ok(status) if !status.success() => {
            return Err(format!("login shell exited with status {status}"));
        }
        Err(e) => return Err(format!("wait on shell: {e}")),
        _ => {}
    }

    Ok(ShellEnvOverlay::parse_null_separated(&buf))
}

#[cfg(unix)]
fn kill_group_and_wait(pid: i32, child: &mut std::process::Child) {
    // -pid signals the entire process group we created via setsid (kill(2)).
    unsafe {
        libc::kill(-pid, libc::SIGKILL);
    }
    let _ = child.wait();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_null_separated_pairs() {
        let raw = b"FOO=bar\0BAZ=qux\0";
        let overlay = ShellEnvOverlay::parse_null_separated(raw);
        assert_eq!(
            overlay.entries(),
            &[
                ("FOO".to_string(), "bar".to_string()),
                ("BAZ".to_string(), "qux".to_string()),
            ]
        );
    }

    #[test]
    fn skips_entries_without_equals() {
        let raw = b"GOOD=value\0BARE_TOKEN\0OTHER=ok\0";
        let overlay = ShellEnvOverlay::parse_null_separated(raw);
        assert_eq!(overlay.len(), 2);
        assert_eq!(overlay.entries()[0].0, "GOOD");
        assert_eq!(overlay.entries()[1].0, "OTHER");
    }

    #[test]
    fn handles_values_containing_equals_signs() {
        let raw = b"URL=https://example.com/?a=1&b=2\0";
        let overlay = ShellEnvOverlay::parse_null_separated(raw);
        assert_eq!(overlay.len(), 1);
        assert_eq!(overlay.entries()[0].1, "https://example.com/?a=1&b=2");
    }

    #[test]
    fn empty_input_yields_empty_overlay() {
        assert!(ShellEnvOverlay::parse_null_separated(b"").is_empty());
        assert!(ShellEnvOverlay::parse_null_separated(b"\0\0\0").is_empty());
    }

    #[test]
    fn handles_multiline_values() {
        let raw = b"MULTI=line1\nline2\nline3\0NEXT=ok\0";
        let overlay = ShellEnvOverlay::parse_null_separated(raw);
        assert_eq!(overlay.len(), 2);
        assert_eq!(overlay.entries()[0].1, "line1\nline2\nline3");
    }

    #[cfg(unix)]
    #[test]
    fn capture_returns_at_least_path() {
        let overlay = ShellEnvOverlay::capture();
        assert!(
            !overlay.is_empty(),
            "expected at least one entry from login shell"
        );
        let has_path = overlay.entries().iter().any(|(k, _)| k == "PATH");
        assert!(has_path, "expected PATH in captured shell env");
    }

    #[test]
    fn entries_for_kernel_launch_filters_activation_vars() {
        let overlay = ShellEnvOverlay::parse_null_separated(
            b"PYTHONPATH=/user/path\0FOO=bar\0VIRTUAL_ENV=/user/venv\0BAZ=qux\0\
              CONDA_PREFIX=/c\0PIXI_PROJECT_ROOT=/p\0PYTHONHOME=/h\0SHELL_API_KEY=secret-12345\0",
        );
        let kept: Vec<&str> = overlay
            .entries_for_kernel_launch()
            .map(|(k, _)| k.as_str())
            .collect();
        assert_eq!(kept, vec!["FOO", "BAZ", "SHELL_API_KEY"]);
    }

    #[test]
    fn drops_non_utf8_values_silently() {
        let raw: &[u8] = &[
            b'G', b'O', b'O', b'D', b'=', b'v', b'a', b'l', 0, b'B', b'A', b'D', b'=', 0xff, 0xfe,
            0, b'O', b'K', b'=', b'1', b'2', b'3', b'4', b'5', b'6', b'7', b'8', 0,
        ];
        let overlay = ShellEnvOverlay::parse_null_separated(raw);
        let keys: Vec<&str> = overlay.entries().iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(keys, vec!["GOOD", "OK"]);
    }
}
