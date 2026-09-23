//! Opt-in real package solves/installs. These tests use temporary prefixes and
//! the normal rattler download cache; they never mutate a user's conda env.
#![cfg(feature = "runtime")]
#![allow(clippy::unwrap_used, clippy::expect_used)]

use kernel_env::{conda, pixi, CondaDependencies, LogHandler};
use rattler_conda_types::PrefixRecord;
use std::{path::Path, sync::Arc};

async fn assert_python_312(python: &Path, extra_import: &str) {
    let code = format!(
        "import sys, ipykernel, ipywidgets, anywidget, pyarrow, nbformat, nteract_kernel_launcher; import {extra_import}; assert sys.version_info[:2] == (3, 12), sys.version; print(sys.version)"
    );
    let output = tokio::process::Command::new(python)
        .args(["-c", &code])
        .output()
        .await
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    eprintln!("{}", String::from_utf8_lossy(&output.stdout));
}

async fn conda_create_and_sync(channels: &[&str]) {
    if channels.contains(&"main-x") {
        let storage = rattler_networking::AuthenticationStorage::from_env_and_defaults().unwrap();
        let (_, auth) = storage
            .get_by_url("https://repo.anaconda.cloud/repo/main-x/noarch/")
            .unwrap();
        assert!(auth.is_some(), "main-x download verification requires credentials: configure the rattler/Pixi store (ana feature enable main-x --pixi) or RATTLER_AUTH_FILE");
    }
    let dir = tempfile::tempdir().unwrap();
    let mut deps = CondaDependencies {
        dependencies: if channels.contains(&"main-x") {
            vec!["https://repo.anaconda.cloud/repo/main-x::a2wsgi".into()]
        } else {
            vec![]
        },
        channels: channels.iter().map(|s| (*s).into()).collect(),
        python: Some("3.12.*".into()),
        env_id: None,
    };
    let env = conda::prepare_environment_in(&deps, dir.path(), Arc::new(LogHandler))
        .await
        .unwrap();
    assert_python_312(&env.python_path, "json").await;
    if channels.contains(&"main-x") {
        assert_python_312(&env.python_path, "a2wsgi").await;
        let records = PrefixRecord::collect_from_prefix::<PrefixRecord>(&env.env_path).unwrap();
        let package = records
            .iter()
            .find(|record| record.repodata_record.package_record.name.as_normalized() == "a2wsgi")
            .unwrap();
        assert!(package
            .repodata_record
            .channel
            .as_deref()
            .unwrap()
            .starts_with("https://repo.anaconda.cloud/repo/main-x"));
    }
    let python_before = PrefixRecord::collect_from_prefix::<PrefixRecord>(&env.env_path)
        .unwrap()
        .into_iter()
        .find(|r| r.repodata_record.package_record.name.as_normalized() == "python")
        .unwrap()
        .repodata_record;
    deps.dependencies.push("six".into());
    conda::sync_dependencies(&env, &deps, Arc::new(LogHandler))
        .await
        .unwrap();
    assert_python_312(&env.python_path, "six").await;
    let python_after = PrefixRecord::collect_from_prefix::<PrefixRecord>(&env.env_path)
        .unwrap()
        .into_iter()
        .find(|r| r.repodata_record.package_record.name.as_normalized() == "python")
        .unwrap()
        .repodata_record;
    assert_eq!(
        python_before, python_after,
        "sync must preserve the exact Python package"
    );
}

#[tokio::test]
#[ignore = "downloads and installs packages from Anaconda main"]
async fn main_python_312_create_and_sync() {
    conda_create_and_sync(&["main"]).await;
}

#[tokio::test]
#[ignore = "downloads and installs packages from conda-forge"]
async fn conda_forge_python_312_create_and_sync() {
    conda_create_and_sync(&["conda-forge"]).await;
}

#[tokio::test]
#[ignore = "requires Anaconda main-x credentials in the rattler/Pixi store"]
async fn main_and_main_x_python_312_create_and_sync() {
    conda_create_and_sync(&["main", "main-x"]).await;
}

#[tokio::test]
#[ignore = "downloads and installs packages from Anaconda main"]
async fn pixi_main_python_312() {
    let dir = tempfile::tempdir().unwrap();
    let mut packages = conda::conda_base_packages();
    packages.push("python=3.12".into());
    let env = pixi::create_pixi_environment(
        dir.path(),
        &packages,
        &["main".into()],
        Arc::new(LogHandler),
    )
    .await
    .unwrap();
    assert_python_312(&env.python_path, "json").await;
    let manifest = std::fs::read_to_string(dir.path().join("pixi.toml")).unwrap();
    assert!(manifest.contains("https://repo.anaconda.com/pkgs/main/"));
    assert!(manifest.contains("python = \"=3.12\""));
}
