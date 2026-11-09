//! Daemon-scoped cache for the vendored launcher package and the kernel
//! entry script.
//!
//! `uv run` (and `pixi exec`) create ephemeral envs per invocation, so
//! we can't vendor into them the way we do for inline/prewarmed/conda/
//! pixi pool envs. Instead we stash a copy of the launcher package at a
//! stable cache path and inject its parent directory via `PYTHONPATH` so
//! `nteract_kernel_launcher` resolves inside the child interpreter.
//!
//! Python kernels start through `kernel_entry.py` rather than
//! `python -m <launcher>`. Kernels run with the notebook's directory as their
//! working directory, and `-m` puts that directory first on `sys.path` before
//! locating the module, so a `nteract_kernel_launcher.py` (or
//! `ipykernel_launcher.py`) next to the notebook would start instead of the
//! real launcher. The entry script lives alone in its own directory, locates
//! the launcher before the working directory is on `sys.path`, then restores
//! the working directory at `sys.path[0]` and runs the launcher as
//! `__main__`. Notebooks keep importing sibling modules exactly as they do
//! under `-m`. See the script's docstring for details.
//!
//! Writes are atomic (temp file + rename per entry) and single-flighted
//! via `tokio::sync::OnceCell`, so two concurrent first-bootstrap launches
//! don't race each other on partially-written module files.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use kernel_env::launcher::{write_package_files, LAUNCHER_PKG};
use tokio::sync::OnceCell;

static CACHED_PARENT: OnceCell<PathBuf> = OnceCell::const_new();
static CACHED_KERNEL_ENTRY: OnceCell<PathBuf> = OnceCell::const_new();

const KERNEL_ENTRY_DIR: &str = "kernel-entry";
const KERNEL_ENTRY_FILE: &str = "kernel_entry.py";
const KERNEL_ENTRY_SOURCE: &str =
    include_str!("../../../python/nteract-kernel-launcher/kernel_entry.py");

/// Return the directory containing the cached launcher **package**, suitable
/// for injecting as `PYTHONPATH` so `nteract_kernel_launcher` resolves
/// without vendoring it into the kernel's environment.
///
/// Layout: `<daemon_base_dir>/launcher/nteract_kernel_launcher/<*.py>`. The
/// returned path is `<daemon_base_dir>/launcher/`. Python walks `sys.path`
/// entries looking for the package by name.
pub async fn launcher_cache_dir() -> Result<PathBuf> {
    CACHED_PARENT.get_or_try_init(materialize).await.cloned()
}

async fn materialize() -> Result<PathBuf> {
    let parent = runt_workspace::daemon_base_dir().join("launcher");
    tokio::fs::create_dir_all(&parent)
        .await
        .with_context(|| format!("create launcher cache dir {parent:?}"))?;

    let pkg_dir = parent.join(LAUNCHER_PKG);
    write_package_files(&pkg_dir)
        .await
        .with_context(|| format!("write launcher package at {pkg_dir:?}"))?;

    Ok(parent)
}

/// Return the absolute path of the kernel entry script.
///
/// Layout: `<daemon_base_dir>/kernel-entry/kernel_entry.py`. The script gets a
/// directory of its own, outside the `PYTHONPATH` launcher directory, because
/// Python puts the script's directory at `sys.path[0]` while it locates the
/// launcher.
pub async fn kernel_entry_script() -> Result<PathBuf> {
    CACHED_KERNEL_ENTRY
        .get_or_try_init(|| {
            write_kernel_entry(runt_workspace::daemon_base_dir().join(KERNEL_ENTRY_DIR))
        })
        .await
        .cloned()
}

async fn write_kernel_entry(dir: PathBuf) -> Result<PathBuf> {
    tokio::fs::create_dir_all(&dir)
        .await
        .with_context(|| format!("create kernel entry dir {dir:?}"))?;

    let final_path = dir.join(KERNEL_ENTRY_FILE);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp_path = dir.join(format!(
        ".{KERNEL_ENTRY_FILE}.tmp.{}.{nanos}",
        std::process::id()
    ));
    tokio::fs::write(&tmp_path, KERNEL_ENTRY_SOURCE)
        .await
        .with_context(|| format!("write {tmp_path:?}"))?;
    tokio::fs::rename(&tmp_path, &final_path)
        .await
        .with_context(|| format!("rename into place at {final_path:?}"))?;
    Ok(final_path)
}

/// Module the kernel entry script runs: nteract's launcher, or stock
/// `ipykernel_launcher` when the enhanced launcher is disabled.
pub fn launcher_module(bootstrap_dx: bool) -> &'static str {
    if bootstrap_dx {
        "nteract_kernel_launcher"
    } else {
        "ipykernel_launcher"
    }
}

/// Interpreter arguments that start a Python kernel, everything after the
/// `python` executable itself.
pub fn python_kernel_args(
    kernel_entry: &Path,
    bootstrap_dx: bool,
    connection_file: &Path,
) -> Vec<OsString> {
    vec![
        OsString::from("-Xfrozen_modules=off"),
        kernel_entry.as_os_str().to_owned(),
        OsString::from(launcher_module(bootstrap_dx)),
        OsString::from("-f"),
        connection_file.as_os_str().to_owned(),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn python_kernel_args_run_the_entry_script_by_path() {
        let entry = Path::new("/cache/kernel-entry/kernel_entry.py");
        let conn = Path::new("/connections/kernel.json");
        for (bootstrap_dx, module) in [
            (true, "nteract_kernel_launcher"),
            (false, "ipykernel_launcher"),
        ] {
            let args = python_kernel_args(entry, bootstrap_dx, conn);
            assert_eq!(
                args,
                [
                    OsString::from("-Xfrozen_modules=off"),
                    entry.as_os_str().to_owned(),
                    OsString::from(module),
                    OsString::from("-f"),
                    conn.as_os_str().to_owned(),
                ]
            );
            assert!(!args.iter().any(|arg| arg == "-m"));
        }
    }

    #[tokio::test]
    async fn kernel_entry_is_written_alone_in_its_own_directory() {
        let tmp = tempfile::TempDir::new().unwrap();
        let dir = tmp.path().join(KERNEL_ENTRY_DIR);

        let script = write_kernel_entry(dir.clone()).await.unwrap();
        // Rewriting over an existing copy must also succeed.
        let rewritten = write_kernel_entry(dir.clone()).await.unwrap();

        assert_eq!(script, rewritten);
        assert!(script.is_absolute());
        assert_eq!(script, dir.join(KERNEL_ENTRY_FILE));
        assert_eq!(
            tokio::fs::read_to_string(&script).await.unwrap(),
            KERNEL_ENTRY_SOURCE
        );
        let entries: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(entries, [std::ffi::OsString::from(KERNEL_ENTRY_FILE)]);
    }

    /// Starts a stand-in launcher through the real entry script with the
    /// working directory holding a same-named module and a sibling module.
    #[cfg(unix)]
    #[tokio::test]
    async fn kernel_entry_starts_managed_launcher_and_keeps_sibling_imports() {
        use kernel_env::CommandOutputExt;

        let tmp = tempfile::TempDir::new().unwrap();
        let script = write_kernel_entry(tmp.path().join(KERNEL_ENTRY_DIR))
            .await
            .unwrap();

        let managed = tmp.path().join("launcher");
        let pkg = managed.join("nteract_kernel_launcher");
        std::fs::create_dir_all(&pkg).unwrap();
        std::fs::write(pkg.join("__init__.py"), "").unwrap();
        std::fs::write(
            pkg.join("__main__.py"),
            "import os, sys, helpers\n\
             print(helpers.VALUE)\n\
             print(sys.path[0] == os.getcwd())\n\
             print(sys.argv[1:])\n",
        )
        .unwrap();

        let notebook_dir = tmp.path().join("notebook dir");
        std::fs::create_dir_all(&notebook_dir).unwrap();
        std::fs::write(notebook_dir.join("helpers.py"), "VALUE = 'sibling'\n").unwrap();
        std::fs::write(
            notebook_dir.join("nteract_kernel_launcher.py"),
            "print('local module')\n",
        )
        .unwrap();

        let output = match tokio::process::Command::new("python3")
            .args(python_kernel_args(
                &script,
                true,
                Path::new("connection.json"),
            ))
            .current_dir(&notebook_dir)
            .env("PYTHONPATH", &managed)
            .env_remove("PYTHONSAFEPATH")
            .output_owned()
            .await
        {
            Ok(output) => output,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                eprintln!("skipping: no python3 on PATH");
                return;
            }
            Err(err) => panic!("spawn python3: {err}"),
        };

        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            String::from_utf8_lossy(&output.stdout),
            "sibling\nTrue\n['-f', 'connection.json']\n"
        );
    }
}
