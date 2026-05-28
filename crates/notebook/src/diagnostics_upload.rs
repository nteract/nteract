use crate::cli_install::get_bundled_runt_path;
use crate::menu::{APP_COMMIT_SHA, APP_VERSION};

use flate2::read::GzDecoder;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::Duration;
use uuid::Uuid;

pub const DIAGNOSTICS_UPLOAD_ENDPOINT: &str =
    "https://diagnostics.runtimed.com/v1/diagnostics/uploads";
pub const DIAGNOSTICS_WARNING_BYTES: u64 = 25 * 1024 * 1024;
pub const DIAGNOSTICS_MAX_UPLOAD_BYTES: u64 = 50 * 1024 * 1024;
const UPLOAD_CONTENT_TYPE: &str = "application/gzip";

#[derive(Default)]
pub struct DiagnosticsUploadState {
    archives: Mutex<HashMap<String, PreparedArchive>>,
}

#[derive(Clone)]
struct PreparedArchive {
    path: PathBuf,
    name: String,
    size: u64,
    files: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct PreparedDiagnosticsArchive {
    archive_id: String,
    archive_name: String,
    archive_size: u64,
    files: Vec<String>,
    warning_bytes: u64,
    max_upload_bytes: u64,
}

#[derive(Debug, Serialize)]
pub struct DiagnosticsUploadResult {
    id: String,
    token: String,
    expires_at: String,
    uploaded_bytes: u64,
}

#[derive(Debug, Serialize)]
struct CreateUploadRequest {
    app_version: &'static str,
    commit_sha: String,
    platform: &'static str,
    arch: &'static str,
    channel: String,
    archive_size: u64,
    source_flow: &'static str,
    nonce: String,
}

#[derive(Debug, Deserialize)]
struct CreateUploadResponse {
    id: String,
    token: String,
    upload_url: String,
    expires_at: String,
    limits: UploadLimits,
}

#[derive(Debug, Deserialize)]
struct UploadLimits {
    max_upload_bytes: u64,
    accepted_content_type: String,
}

#[tauri::command]
pub async fn prepare_diagnostics_archive(
    app: tauri::AppHandle,
    state: tauri::State<'_, DiagnosticsUploadState>,
) -> Result<PreparedDiagnosticsArchive, String> {
    let archive_id = Uuid::new_v4().to_string();
    let prepared = tokio::task::spawn_blocking({
        let app = app.clone();
        let archive_id = archive_id.clone();
        move || prepare_archive(&app, &archive_id)
    })
    .await
    .map_err(|e| format!("Failed to prepare diagnostics archive: {e}"))??;

    if prepared.size > DIAGNOSTICS_MAX_UPLOAD_BYTES {
        cleanup_prepared_archive_files(&prepared.path);
        return Err(format!(
            "Diagnostics archive is {} but the upload limit is {}.",
            format_bytes(prepared.size),
            format_bytes(DIAGNOSTICS_MAX_UPLOAD_BYTES)
        ));
    }

    let response = PreparedDiagnosticsArchive {
        archive_id: archive_id.clone(),
        archive_name: prepared.name.clone(),
        archive_size: prepared.size,
        files: prepared.files.clone(),
        warning_bytes: DIAGNOSTICS_WARNING_BYTES,
        max_upload_bytes: DIAGNOSTICS_MAX_UPLOAD_BYTES,
    };

    let mut archives = state.archives.lock().map_err(|e| e.to_string())?;
    if let Some(previous) = archives.insert(archive_id, prepared) {
        cleanup_prepared_archive_files(&previous.path);
    }

    Ok(response)
}

#[tauri::command]
pub async fn upload_prepared_diagnostics(
    state: tauri::State<'_, DiagnosticsUploadState>,
    archive_id: String,
) -> Result<DiagnosticsUploadResult, String> {
    let prepared = {
        let archives = state.archives.lock().map_err(|e| e.to_string())?;
        archives
            .get(&archive_id)
            .cloned()
            .ok_or_else(|| "Diagnostics archive is no longer available.".to_string())?
    };

    let result = upload_archive(&prepared).await;

    if result.is_ok() {
        let mut archives = state.archives.lock().map_err(|e| e.to_string())?;
        if let Some(archive) = archives.remove(&archive_id) {
            cleanup_prepared_archive_files(&archive.path);
        }
    }

    result
}

#[tauri::command]
pub async fn cleanup_prepared_diagnostics(
    state: tauri::State<'_, DiagnosticsUploadState>,
    archive_id: String,
) -> Result<(), String> {
    let archive = {
        let mut archives = state.archives.lock().map_err(|e| e.to_string())?;
        archives.remove(&archive_id)
    };

    if let Some(archive) = archive {
        cleanup_prepared_archive_files(&archive.path);
    }

    Ok(())
}

fn prepare_archive(app: &tauri::AppHandle, archive_id: &str) -> Result<PreparedArchive, String> {
    let runt_path =
        get_bundled_runt_path(app).ok_or_else(|| "Could not find bundled runt CLI.".to_string())?;
    let output_dir = diagnostics_temp_root().join(archive_id);
    fs::create_dir_all(&output_dir).map_err(|e| {
        format!(
            "Failed to create diagnostics temp directory {}: {e}",
            output_dir.display()
        )
    })?;

    let output = Command::new(&runt_path)
        .arg("diagnostics")
        .arg("--output")
        .arg(&output_dir)
        .output()
        .map_err(|e| {
            format!(
                "Failed to run diagnostics command {}: {e}",
                runt_path.display()
            )
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        cleanup_prepared_archive_dir(&output_dir);
        return Err(format!(
            "Diagnostics command failed with status {}: {}",
            output.status,
            stderr.trim()
        ));
    }

    let archive_path = find_diagnostics_archive(&output_dir)?;
    let metadata = fs::metadata(&archive_path).map_err(|e| {
        format!(
            "Failed to inspect diagnostics archive {}: {e}",
            archive_path.display()
        )
    })?;
    let files = list_archive_entries(&archive_path)?;
    let name = archive_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("runt-diagnostics.tar.gz")
        .to_string();

    Ok(PreparedArchive {
        path: archive_path,
        name,
        size: metadata.len(),
        files,
    })
}

async fn upload_archive(prepared: &PreparedArchive) -> Result<DiagnosticsUploadResult, String> {
    if prepared.size > DIAGNOSTICS_MAX_UPLOAD_BYTES {
        return Err(format!(
            "Diagnostics archive is {} but the upload limit is {}.",
            format_bytes(prepared.size),
            format_bytes(DIAGNOSTICS_MAX_UPLOAD_BYTES)
        ));
    }

    let bytes = tokio::fs::read(&prepared.path).await.map_err(|e| {
        format!(
            "Failed to read diagnostics archive {}: {e}",
            prepared.path.display()
        )
    })?;
    let uploaded_bytes = bytes.len() as u64;
    if uploaded_bytes > DIAGNOSTICS_MAX_UPLOAD_BYTES {
        return Err(format!(
            "Diagnostics archive is {} but the upload limit is {}.",
            format_bytes(uploaded_bytes),
            format_bytes(DIAGNOSTICS_MAX_UPLOAD_BYTES)
        ));
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| format!("Failed to create diagnostics upload client: {e}"))?;

    let create_response = client
        .post(DIAGNOSTICS_UPLOAD_ENDPOINT)
        .json(&CreateUploadRequest {
            app_version: APP_VERSION,
            commit_sha: APP_COMMIT_SHA.trim().to_string(),
            platform: diagnostics_platform(),
            arch: diagnostics_arch(),
            channel: runt_workspace::channel_display_name().to_string(),
            archive_size: prepared.size,
            source_flow: "help_menu",
            nonce: Uuid::new_v4().to_string(),
        })
        .send()
        .await
        .map_err(|e| format!("Failed to request diagnostics upload URL: {e}"))?
        .error_for_status()
        .map_err(|e| format!("Diagnostics upload request was rejected: {e}"))?
        .json::<CreateUploadResponse>()
        .await
        .map_err(|e| format!("Failed to read diagnostics upload response: {e}"))?;

    if create_response.limits.max_upload_bytes < prepared.size {
        return Err(format!(
            "Diagnostics archive is {} but the service limit is {}.",
            format_bytes(prepared.size),
            format_bytes(create_response.limits.max_upload_bytes)
        ));
    }

    if create_response.limits.accepted_content_type != UPLOAD_CONTENT_TYPE {
        return Err(format!(
            "Diagnostics service expected unsupported content type {}.",
            create_response.limits.accepted_content_type
        ));
    }

    let upload_url = validate_upload_url(&create_response.upload_url)?;

    client
        .put(upload_url)
        .header(reqwest::header::CONTENT_TYPE, UPLOAD_CONTENT_TYPE)
        .header(reqwest::header::CONTENT_LENGTH, uploaded_bytes)
        .body(bytes)
        .send()
        .await
        .map_err(|e| format!("Failed to upload diagnostics archive: {e}"))?
        .error_for_status()
        .map_err(|e| format!("Diagnostics archive upload was rejected: {e}"))?;

    Ok(DiagnosticsUploadResult {
        id: create_response.id,
        token: create_response.token,
        expires_at: create_response.expires_at,
        uploaded_bytes,
    })
}

fn validate_upload_url(upload_url: &str) -> Result<reqwest::Url, String> {
    let parsed = reqwest::Url::parse(upload_url)
        .map_err(|e| format!("Diagnostics service returned an invalid upload URL: {e}"))?;
    if parsed.scheme() != "https" {
        return Err("Diagnostics service returned a non-HTTPS upload URL.".to_string());
    }
    if parsed.host_str() != Some("diagnostics.runtimed.com") {
        return Err("Diagnostics service returned an unexpected upload URL host.".to_string());
    }
    let Some(upload_id) = parsed.path().strip_prefix("/v1/diagnostics/uploads/") else {
        return Err("Diagnostics service returned an unexpected upload URL path.".to_string());
    };
    if upload_id.is_empty() || upload_id.contains('/') {
        return Err("Diagnostics service returned an unexpected upload URL path.".to_string());
    }
    Ok(parsed)
}

fn diagnostics_temp_root() -> PathBuf {
    std::env::temp_dir().join("runt-diagnostics-upload")
}

fn find_diagnostics_archive(output_dir: &Path) -> Result<PathBuf, String> {
    let mut archives = fs::read_dir(output_dir)
        .map_err(|e| {
            format!(
                "Failed to inspect diagnostics output directory {}: {e}",
                output_dir.display()
            )
        })?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| {
                    name.starts_with("runt-diagnostics-") && name.ends_with(".tar.gz")
                })
        })
        .collect::<Vec<_>>();
    archives.sort();

    match archives.len() {
        1 => Ok(archives.remove(0)),
        0 => Err("Diagnostics command did not create an archive.".to_string()),
        count => Err(format!(
            "Diagnostics command created {count} archives; expected one."
        )),
    }
}

fn list_archive_entries(path: &Path) -> Result<Vec<String>, String> {
    let file = fs::File::open(path)
        .map_err(|e| format!("Failed to open diagnostics archive {}: {e}", path.display()))?;
    let gz = GzDecoder::new(file);
    let mut archive = tar::Archive::new(gz);
    let mut entries = archive
        .entries()
        .map_err(|e| format!("Failed to read diagnostics archive {}: {e}", path.display()))?
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            entry
                .path()
                .ok()
                .map(|path| path.to_string_lossy().to_string())
        })
        .collect::<Vec<_>>();
    entries.sort();
    Ok(entries)
}

fn cleanup_prepared_archive_files(path: &Path) {
    if let Some(parent) = path.parent() {
        let root = diagnostics_temp_root();
        if parent.parent() == Some(root.as_path()) {
            cleanup_prepared_archive_dir(parent);
            return;
        }
    }

    if let Err(err) = fs::remove_file(path) {
        log::debug!(
            "[diagnostics] Failed to remove diagnostics archive {}: {}",
            path.display(),
            err
        );
    }
}

fn cleanup_prepared_archive_dir(path: &Path) {
    if let Err(err) = fs::remove_dir_all(path) {
        log::debug!(
            "[diagnostics] Failed to remove diagnostics temp directory {}: {}",
            path.display(),
            err
        );
    }
}

fn diagnostics_platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "macos",
        "linux" => "linux",
        "windows" => "windows",
        _ => "linux",
    }
}

fn diagnostics_arch() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x86_64",
        _ => "x86_64",
    }
}

fn format_bytes(bytes: u64) -> String {
    const MIB: f64 = 1024.0 * 1024.0;
    format!("{:.1} MiB", bytes as f64 / MIB)
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::write::GzEncoder;
    use flate2::Compression;

    #[test]
    fn upload_endpoint_uses_deployed_diagnostics_path() {
        assert_eq!(
            DIAGNOSTICS_UPLOAD_ENDPOINT,
            "https://diagnostics.runtimed.com/v1/diagnostics/uploads"
        );
    }

    #[test]
    fn limits_match_deployed_service_contract() {
        assert_eq!(DIAGNOSTICS_WARNING_BYTES, 26_214_400);
        assert_eq!(DIAGNOSTICS_MAX_UPLOAD_BYTES, 52_428_800);
    }

    #[test]
    fn upload_url_validation_accepts_deployed_worker_upload_path() {
        let url = validate_upload_url(
            "https://diagnostics.runtimed.com/v1/diagnostics/uploads/abc?token=diag_123",
        )
        .expect("valid upload URL");

        assert_eq!(url.host_str(), Some("diagnostics.runtimed.com"));
    }

    #[test]
    fn upload_url_validation_rejects_unexpected_hosts() {
        let err =
            validate_upload_url("https://example.com/v1/diagnostics/uploads/abc?token=diag_123")
                .expect_err("unexpected host should be rejected");

        assert!(err.contains("unexpected upload URL host"));
    }

    #[test]
    fn upload_url_validation_rejects_unexpected_paths() {
        let err = validate_upload_url(
            "https://diagnostics.runtimed.com/v1/diagnostics/uploads/abc/status?token=diag_123",
        )
        .expect_err("unexpected path should be rejected");

        assert!(err.contains("unexpected upload URL path"));
    }

    #[test]
    fn archive_listing_returns_sorted_member_names() {
        let dir = tempfile::tempdir().expect("tempdir");
        let archive_path = dir.path().join("runt-diagnostics-test.tar.gz");
        let file = fs::File::create(&archive_path).expect("archive file");
        let encoder = GzEncoder::new(file, Compression::default());
        let mut builder = tar::Builder::new(encoder);

        add_test_archive_entry(&mut builder, "system-info.json", b"{}");
        add_test_archive_entry(&mut builder, "runtimed.log", b"log");
        builder.finish().expect("finish archive");
        drop(builder);

        assert_eq!(
            list_archive_entries(&archive_path).expect("entries"),
            vec!["runtimed.log", "system-info.json"]
        );
    }

    fn add_test_archive_entry(
        builder: &mut tar::Builder<GzEncoder<fs::File>>,
        name: &str,
        bytes: &[u8],
    ) {
        let mut header = tar::Header::new_gnu();
        header.set_size(bytes.len() as u64);
        header.set_cksum();
        builder
            .append_data(&mut header, name, bytes)
            .expect("append archive entry");
    }
}
