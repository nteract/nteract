//! Opt-in network qualification. Run the compiled test binary with a disposable
//! HOME, XDG_CACHE_HOME, UV_CACHE_DIR, UV_PYTHON_INSTALL_DIR and PIXI_HOME beneath
//! NTERACT_TOOLCHAIN_FIXTURE_ROOT, and a PATH without uv/pixi. Never use real
//! project environments. See docs/runbooks/python-toolchain-security.md.

// Qualification failures should stop the test; no production code is compiled here.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use kernel_launch::{tools, CommandOutputExt};
use std::path::{Path, PathBuf};
use tokio::process::Command;

fn fixture_root() -> PathBuf {
    let root = PathBuf::from(std::env::var("NTERACT_TOOLCHAIN_FIXTURE_ROOT").unwrap());
    assert!(root.is_absolute());
    for key in [
        "HOME",
        "XDG_CACHE_HOME",
        "UV_CACHE_DIR",
        "UV_PYTHON_INSTALL_DIR",
        "PIXI_HOME",
    ] {
        assert!(
            Path::new(&std::env::var(key).unwrap()).starts_with(&root),
            "{key} must be isolated"
        );
    }
    for key in [
        "UV_INSECURE_HOST",
        "UV_NATIVE_TLS",
        "UV_SYSTEM_CERTS",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
        "REQUESTS_CA_BUNDLE",
    ] {
        assert!(
            std::env::var_os(key).is_none(),
            "qualification requires default TLS: unset {key}"
        );
    }
    root
}

async fn success(command: &mut Command) -> Vec<u8> {
    let output = tokio::time::timeout(std::time::Duration::from_secs(300), command.output_owned())
        .await
        .unwrap()
        .unwrap();
    assert!(
        output.status.success(),
        "command failed: {:?}\n{}\n{}",
        command,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    output.stdout
}

fn python(prefix: &Path) -> PathBuf {
    if cfg!(windows) {
        prefix.join("Scripts/python.exe")
    } else {
        prefix.join("bin/python")
    }
}

const KERNEL_PROBE: &str = r#"
import os, sys
from jupyter_client import KernelManager
km = KernelManager(kernel_name='python3')
km.kernel_spec.argv = [sys.executable, '-m', 'ipykernel_launcher', '-f', '{connection_file}']
km.start_kernel(cwd=os.getcwd(), env=dict(os.environ))
client = km.client()
client.start_channels()
try:
    client.wait_for_ready(timeout=30)
    msg_id = client.execute('print(6 * 7)')
    text = ''
    while True:
        msg = client.get_iopub_msg(timeout=30)
        if msg.get('parent_header', {}).get('msg_id') != msg_id:
            continue
        if msg['msg_type'] == 'stream':
            text += msg['content']['text']
        if msg['msg_type'] == 'error':
            raise AssertionError(msg['content'])
        if msg['msg_type'] == 'status' and msg['content']['execution_state'] == 'idle':
            break
    assert text.strip() == '42', text
    print('KERNEL_OK', sys.executable)
finally:
    client.stop_channels()
    km.shutdown_kernel(now=True)
"#;

#[tokio::test]
#[ignore = "downloads pinned tools/Python/packages and starts disposable kernels; requires isolated environment"]
async fn pinned_toolchain_environment_and_kernel_contracts() {
    let root = fixture_root();
    let uv = tools::get_uv_path().await.unwrap();
    let pixi = tools::get_pixi_path().await.unwrap();
    assert_eq!(
        uv,
        tools::cached_tool_binary_path("uv", Some(tools::UV_TARGET_VERSION))
    );
    assert_eq!(
        pixi,
        tools::cached_tool_binary_path("pixi", Some(tools::PIXI_TARGET_VERSION))
    );
    assert!(uv.starts_with(&root) && pixi.starts_with(&root));
    println!("uv: {}\npixi: {}", uv.display(), pixi.display());
    let venv = root.join("uv environment");
    success(
        Command::new(&uv)
            .args([
                "venv",
                "--no-config",
                "--managed-python",
                "--python",
                "3.13",
            ])
            .arg(&venv)
            .current_dir(&root),
    )
    .await;
    let uv_python = python(&venv);
    success(
        Command::new(&uv)
            .args([
                "pip",
                "install",
                "--no-config",
                "--link-mode",
                "hardlink",
                "--python",
            ])
            .arg(&uv_python)
            .args([
                "ipykernel",
                "ipywidgets",
                "anywidget",
                "nbformat",
                "pyarrow>=14",
                "uv",
            ])
            .current_dir(&root),
    )
    .await;
    success(
        Command::new(&uv)
            .args(["pip", "list", "--format", "json", "--python"])
            .arg(&uv_python)
            .current_dir(&root),
    )
    .await;
    let probe = root.join("kernel_probe.py");
    std::fs::write(&probe, KERNEL_PROBE).unwrap();
    println!(
        "{}",
        String::from_utf8_lossy(
            &success(Command::new(&uv_python).arg(&probe).current_dir(&root)).await
        )
    );

    // Exercise uv's project runner separately from managed venv creation.
    let project = root.join("uv project");
    std::fs::create_dir_all(&project).unwrap();
    std::fs::write(project.join("pyproject.toml"), "[project]\nname = 'toolchain-probe'\nversion = '0.0.0'\nrequires-python = '>=3.13,<3.14'\ndependencies = []\n").unwrap();
    success(
        Command::new(&uv)
            .args([
                "run",
                "--no-config",
                "--managed-python",
                "--with",
                "ipykernel",
                "python",
            ])
            .arg(&probe)
            .current_dir(&project),
    )
    .await;

    let project = root.join("pixi project");
    std::fs::create_dir_all(&project).unwrap();
    let manifest = project.join("pixi.toml");
    let platform = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => "osx-arm64",
        ("macos", _) => "osx-64",
        ("linux", "aarch64") => "linux-aarch64",
        ("linux", _) => "linux-64",
        ("windows", _) => "win-64",
        _ => panic!("unsupported platform"),
    };
    std::fs::write(&manifest, format!("[workspace]\nname = 'toolchain-probe'\nchannels = ['conda-forge']\nplatforms = ['{platform}']\n[dependencies]\npython = '3.13.*'\nipykernel = '*'\n")).unwrap();
    success(
        Command::new(&pixi)
            .args(["install", "--manifest-path"])
            .arg(&manifest)
            .current_dir(&root),
    )
    .await;
    let info = tools::pixi_info(&manifest).await.unwrap();
    assert!(info.has_ipykernel());
    assert!(info.default_deps_snapshot().contains(&"python".to_string()));
    let prefix = PathBuf::from(
        info.default_prefix()
            .expect("pixi info must return the default prefix"),
    );
    assert!(prefix.starts_with(&project));
    let activation = tools::pixi_shell_hook(
        &manifest,
        Some("default"),
        &std::collections::HashMap::from([("PIXI_FROZEN".to_string(), "true".to_string())]),
    )
    .await
    .unwrap();
    assert!(activation.contains_key("PATH"));
    let pixi_python = if cfg!(windows) {
        prefix.join("python.exe")
    } else {
        python(&prefix)
    };
    println!(
        "{}",
        String::from_utf8_lossy(
            &success(
                Command::new(&pixi_python)
                    .arg(&probe)
                    .envs(&activation)
                    .current_dir(&project)
            )
            .await
        )
    );
}

#[tokio::test]
#[ignore = "read-only public TLS probes; requires isolated environment and working network"]
async fn native_tls_rejects_affected_chains_with_positive_control() {
    fixture_root();
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .unwrap();
    assert!(client
        .get("https://pypi.org/simple/ipykernel/")
        .send()
        .await
        .unwrap()
        .status()
        .is_success());
    println!("positive control: PyPI accepted");
    let mut failures = Vec::new();
    for host in ["dv-g3b", "dv-g3b-aaa", "dv-g3b-noct", "dv-g3b-aaa-noct"] {
        let url = format!("https://{host}-emudhra.we-have-a-problem.com/");
        match client.get(&url).send().await {
            Ok(response) => {
                let detail = format!("{host}: UNSAFE chain accepted, HTTP {}", response.status());
                println!("{detail}");
                failures.push(detail);
            }
            Err(error) => {
                let detail = format!("{host}: {error:?}");
                println!("{detail}");
                if error.is_timeout() || !detail.to_lowercase().contains("certificate") {
                    failures.push(format!(
                        "inconclusive (not a certificate rejection): {detail}"
                    ));
                }
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
