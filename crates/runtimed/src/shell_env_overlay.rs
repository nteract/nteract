//! Capture the user's shell startup environment once at daemon startup. The
//! daemon's own process env is never modified; the overlay is injected into
//! each `LaunchKernel`/`RestartKernel` RPC's `env_vars` field so the toggle
//! is honored per-launch without a runtime-agent respawn.

use tracing::warn;

#[cfg(unix)]
const CAPTURE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);
#[cfg(unix)]
const DEFAULT_SHELL_CAPTURE_SCRIPT: &str = "env -0";
#[cfg(unix)]
const BASH_CAPTURE_SCRIPT: &str =
    "printf '\\0'; if [ -r \"$HOME/.bashrc\" ]; then . \"$HOME/.bashrc\" >/dev/null 2>&1; fi; env -0";
#[cfg(unix)]
const ZSH_CAPTURE_SCRIPT: &str =
    "printf '\\0'; if [[ -r \"$HOME/.zshrc\" ]]; then source \"$HOME/.zshrc\" >/dev/null 2>&1; fi; env -0";

/// Env vars the daemon or the surrounding process tree manages directly. The
/// overlay must not stomp these on the kernel `Command`:
///
/// - **Python/env-manager activation** (`PYTHONPATH`, `VIRTUAL_ENV`, `CONDA_*`,
///   `PIXI_*`) would redirect a pooled uv/conda kernel into the wrong Python
///   or clobber the launcher `PYTHONPATH` set in `jupyter_kernel.rs`.
/// - **System identity / PATH** (`PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`,
///   `PWD`, `OLDPWD`) - the kernel `Command` inherits these from the daemon's
///   process env. Overriding `PATH` with the user's login-shell `PATH` is the
///   bug that broke CI: `get_uv_path` may return bare `"uv"`, and the spawn
///   then ENOENTs because the shell `PATH` lacks the uv install dir.
/// - **`uv` internal state** (`UV`, `UV_RUN_RECURSION_DEPTH`) - inherited from
///   the parent `uv run` and meaningless to the kernel; honoring them in a
///   child process makes uv mistake recursion depth.
///
/// Anything not in this list - `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, user-set
/// `MPLBACKEND`, etc. - still flows through to the kernel.
const ACTIVATION_DENYLIST: &[&str] = &[
    // Python / env-manager activation
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
    // System identity / PATH
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "PWD",
    "OLDPWD",
    // uv recursion / internal markers
    "UV",
    "UV_RUN_RECURSION_DEPTH",
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
    /// (`PYTHONPATH`, `VIRTUAL_ENV`, `CONDA_*`, `PIXI_*`, `PATH`, etc.)
    /// filtered out. `PATH` is filtered here because the daemon and the user
    /// shell each contribute - callers use `build_kernel_env_vars` to get a
    /// merged `PATH` rather than honoring this iterator's omission.
    pub fn entries_for_kernel_launch(&self) -> impl Iterator<Item = &(String, String)> {
        self.entries
            .iter()
            .filter(|(k, _)| !ACTIVATION_DENYLIST.contains(&k.as_str()))
    }

    /// Build the `env_vars` map for a kernel launch:
    /// filter daemon-managed vars out of the overlay, then **merge** the
    /// user's shell `PATH` with `daemon_path` so the kernel inherits both
    /// daemon-managed tool dirs (where `uv` lives, often the cache install or
    /// `/usr/local/bin` on the runner) and the user's shell `PATH`
    /// (`~/.local/bin`, `/opt/homebrew/bin`, project-specific dirs from rc
    /// files, etc.).
    ///
    /// User entries come first so `!brew`, `!gh`, etc. resolve to the user's
    /// preferred binaries; daemon entries come after as a fallback so
    /// `Command::new("uv").spawn()` still finds uv even when the user's
    /// shell `PATH` does not include the install dir.
    pub fn build_kernel_env_vars(
        &self,
        daemon_path: &str,
    ) -> std::collections::HashMap<String, String> {
        let mut env: std::collections::HashMap<String, String> = self
            .entries_for_kernel_launch()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        if let Some(user_path) = self.path_value() {
            let merged = merge_paths(user_path, daemon_path);
            env.insert("PATH".to_string(), merged);
        }
        env
    }

    fn path_value(&self) -> Option<&str> {
        self.entries
            .iter()
            .find(|(k, _)| k == "PATH")
            .map(|(_, v)| v.as_str())
    }

    #[cfg(unix)]
    pub fn capture() -> Self {
        match capture_inner() {
            Ok(overlay) => {
                tracing::info!(
                    "[shell-env-overlay] captured {} entries from shell startup",
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

/// Merge two `PATH`-style colon-separated lists, preferring entries from
/// `user` and appending non-duplicate entries from `daemon`. Empty strings
/// in either side pass through cleanly.
///
/// Exposed so `jupyter_kernel.rs` can re-merge when the per-launch kernel
/// command already has a `PATH` set (e.g. pixi shell-hook output) and we
/// want to preserve those entries while still adding the user's shell PATH.
pub fn merge_paths(user: &str, daemon: &str) -> String {
    if user.is_empty() {
        return daemon.to_string();
    }
    if daemon.is_empty() {
        return user.to_string();
    }
    let user_entries: std::collections::HashSet<&str> = user.split(':').collect();
    let mut merged = user.to_string();
    for entry in daemon.split(':') {
        if entry.is_empty() || user_entries.contains(entry) {
            continue;
        }
        merged.push(':');
        merged.push_str(entry);
    }
    merged
}

#[cfg(unix)]
fn capture_inner() -> Result<ShellEnvOverlay, String> {
    use std::io::Read;
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};

    let shell = std::env::var_os("SHELL").unwrap_or_else(|| std::ffi::OsString::from("/bin/zsh"));
    let script = capture_script_for_shell(&shell);

    let mut cmd = Command::new(&shell);
    cmd.args(["-l", "-c", script])
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
                "shell startup capture timed out after {CAPTURE_TIMEOUT:?}"
            ));
        }
    };

    match child.wait() {
        Ok(status) if !status.success() => {
            return Err(format!("shell startup capture exited with status {status}"));
        }
        Err(e) => return Err(format!("wait on shell: {e}")),
        _ => {}
    }

    Ok(ShellEnvOverlay::parse_null_separated(&buf))
}

#[cfg(unix)]
fn capture_script_for_shell(shell: &std::ffi::OsStr) -> &'static str {
    let shell_name = std::path::Path::new(shell)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    match shell_name {
        "bash" => BASH_CAPTURE_SCRIPT,
        "zsh" => ZSH_CAPTURE_SCRIPT,
        _ => DEFAULT_SHELL_CAPTURE_SCRIPT,
    }
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
            "expected at least one entry from shell startup"
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
    fn entries_for_kernel_launch_filters_path_and_uv_markers() {
        // PATH is dropped here so callers route through `build_kernel_env_vars`
        // instead. HOME/USER/etc. are denylisted because they're daemon
        // process identity and shouldn't be re-asserted by the overlay.
        let overlay = ShellEnvOverlay::parse_null_separated(
            b"PATH=/user/bin\0HOME=/u/home\0USER=alice\0LOGNAME=alice\0SHELL=/bin/zsh\0\
              PWD=/u\0OLDPWD=/u/prev\0UV=/opt/uv\0UV_RUN_RECURSION_DEPTH=1\0\
              ANTHROPIC_API_KEY=sk-keep-me\0",
        );
        let kept: Vec<&str> = overlay
            .entries_for_kernel_launch()
            .map(|(k, _)| k.as_str())
            .collect();
        assert_eq!(kept, vec!["ANTHROPIC_API_KEY"]);
    }

    #[test]
    fn build_kernel_env_vars_merges_user_path_with_daemon_path() {
        // Regression test for the CI failure where overlay PATH replaced the
        // daemon's PATH and `Command::new("uv").spawn()` returned ENOENT.
        // Both halves must be present and the user's entries must come first.
        let overlay = ShellEnvOverlay::parse_null_separated(
            b"PATH=/home/runner/.local/bin:/usr/local/bin:/usr/bin\0\
              ANTHROPIC_API_KEY=sk-keep-me\0",
        );
        let daemon_path = "/cache/runt/bin:/usr/local/bin:/opt/cache/uv";
        let env = overlay.build_kernel_env_vars(daemon_path);

        let path = env.get("PATH").expect("PATH should be set");
        // Order: user entries first.
        assert!(path.starts_with("/home/runner/.local/bin:/usr/local/bin:/usr/bin"));
        // Daemon-only entries appended, deduped (no second /usr/local/bin).
        assert!(path.contains(":/cache/runt/bin"));
        assert!(path.contains(":/opt/cache/uv"));
        assert_eq!(path.matches("/usr/local/bin").count(), 1);

        assert_eq!(
            env.get("ANTHROPIC_API_KEY").map(String::as_str),
            Some("sk-keep-me")
        );
    }

    #[test]
    fn build_kernel_env_vars_handles_empty_paths() {
        let overlay = ShellEnvOverlay::parse_null_separated(b"PATH=/u/bin\0");
        assert_eq!(
            overlay
                .build_kernel_env_vars("")
                .get("PATH")
                .map(String::as_str),
            Some("/u/bin"),
        );

        let overlay = ShellEnvOverlay::parse_null_separated(b"OTHER=ok\0");
        let env = overlay.build_kernel_env_vars("/daemon/bin");
        // No user PATH => kernel inherits daemon PATH naturally; we don't set it.
        assert!(!env.contains_key("PATH"));
    }

    #[cfg(unix)]
    #[test]
    fn zsh_capture_sources_zshrc_before_env_dump() {
        let script = capture_script_for_shell(std::ffi::OsStr::new("/bin/zsh"));
        assert!(script.contains(".zshrc"));
        assert!(script.contains("env -0"));
    }

    #[cfg(unix)]
    #[test]
    fn unknown_shells_use_plain_env_capture() {
        assert_eq!(
            capture_script_for_shell(std::ffi::OsStr::new("/usr/bin/fish")),
            DEFAULT_SHELL_CAPTURE_SCRIPT,
        );
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
