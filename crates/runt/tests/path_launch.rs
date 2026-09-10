#![cfg(unix)]
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::Command;
use std::time::{Duration, Instant};

fn cli(root: &Path, invoking_directory: &Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_nteract-cli"));
    command
        .env_clear()
        .env("HOME", root)
        .env("USERPROFILE", root)
        .env("XDG_CONFIG_HOME", root.join("config"))
        .env("XDG_CACHE_HOME", root.join("cache"))
        .env("XDG_DATA_HOME", root.join("data"))
        .env("RUNTIMED_DEV", "1")
        .env("RUNTIMED_WORKSPACE_PATH", root)
        .env("CARGO_TARGET_DIR", root.join("target"))
        .env("NTERACT_TEST_ARGS", root.join("arguments"))
        .current_dir(invoking_directory);
    command
}

#[test]
fn path_launch_passes_the_invoking_directory_to_its_own_desktop() {
    // macOS's default temporary directory leaves too little room for a Unix
    // socket after adding the isolated runtime namespace.
    let temp = tempfile::tempdir_in("/tmp").unwrap();
    let root = temp.path();
    let bin_dir = root.join("target/debug");
    std::fs::create_dir_all(&bin_dir).unwrap();
    let desktop = bin_dir.join("notebook");
    std::fs::write(
        &desktop,
        "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$NTERACT_TEST_ARGS\"\n",
    )
    .unwrap();
    std::fs::set_permissions(&desktop, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::write(bin_dir.join(".notebook-bundled"), "").unwrap();

    let invoking = root.join("terminal directory");
    std::fs::create_dir_all(invoking.join("my project")).unwrap();
    std::fs::create_dir_all(invoking.join("nb")).unwrap();
    std::fs::write(invoking.join("open"), "{}").unwrap();
    // getcwd resolves the temporary directory's /var symlink on macOS.
    let invoking = invoking.canonicalize().unwrap();

    for args in [
        vec!["."],
        vec!["./my project"],
        vec!["./nb"],
        vec!["./open"],
        vec!["analysis.ipynb"],
        vec!["open", "."],
    ] {
        let output = cli(root, &invoking).args(&args).output().unwrap();
        assert!(
            output.status.success(),
            "{args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let expected = format!("{}\n", invoking.join(args.last().unwrap()).display());
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if std::fs::read_to_string(root.join("arguments"))
                .ok()
                .as_deref()
                == Some(expected.as_str())
            {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "Desktop did not receive {expected:?}"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        std::fs::remove_file(root.join("arguments")).unwrap();
    }

    let output = cli(root, &invoking).arg("workstaiton").output().unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert!(!root.join("arguments").exists());
}
