//! `runt workstation` — pair this machine with a hosted nteract cloud and
//! serve attach requests.
//!
//! The operator path (`docs/remote-workstation.md`, ADR
//! `docs/adr/hosted-credential-transport.md` Decision 9):
//!
//! 1. Mint a pairing code in the hosted workstation panel.
//! 2. `runt workstation connect <url> --code XXXX-XXXX-XXXX` redeems it for a
//!    long-lived workstation credential (`nwc_` token) and stores it at
//!    [`runt_workspace::workstation_credentials_path`] (mode 0600).
//! 3. `runt workstation run` launches the sibling `runtimed workstation-agent`
//!    service loop with the credential in the environment (never argv).
//!
//! `runt workstation status` lists the workstations the credential can see.

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

/// Environment variable carrying the workstation credential. Overrides the
/// credential file when set; also how `run` hands the token to `runtimed`.
pub const CLOUD_TOKEN_ENV: &str = "RUNT_CLOUD_TOKEN";
/// Environment override for the cloud base URL.
pub const CLOUD_URL_ENV: &str = "RUNT_CLOUD_URL";

#[derive(clap::Subcommand)]
pub enum WorkstationCommands {
    /// Pair this machine with a hosted cloud using a pairing code
    Connect {
        /// Base URL of the hosted nteract cloud (e.g. https://app.runt.run)
        url: String,
        /// Pairing code from the workstation panel (XXXX-XXXX-XXXX);
        /// prompts on stdin when omitted
        #[arg(long)]
        code: Option<String>,
        /// Stable workstation id (default: ws-<hostname slug>)
        #[arg(long)]
        id: Option<String>,
        /// Display name shown in the workstation panel (default: hostname)
        #[arg(long)]
        name: Option<String>,
    },
    /// Serve attach requests using the stored workstation credential
    Run {
        /// Python interpreter used for launch-on-attach kernels.
        ///
        /// This is a pragmatic override until workstation setup grows a
        /// first-run configuration flow. The value is passed to the sibling
        /// `runtimed workstation-agent`; credentials still ride only in the
        /// environment.
        #[arg(long)]
        python_path: Option<PathBuf>,
    },
    /// List workstations registered to the stored credential
    Status {
        /// Output raw JSON
        #[arg(long)]
        json: bool,
    },
}

pub async fn command(command: WorkstationCommands) -> Result<()> {
    match command {
        WorkstationCommands::Connect {
            url,
            code,
            id,
            name,
        } => connect(url, code, id, name).await,
        WorkstationCommands::Run { python_path } => run(python_path).await,
        WorkstationCommands::Status { json } => status(json).await,
    }
}

/// Stored credential file: `workstation.json` in the config directory
/// (per-worktree in dev mode). Created with mode 0600 — it holds the bearer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkstationCredentialFile {
    pub cloud_url: String,
    pub token: String,
    pub credential_id: String,
    pub workstation_id: String,
    pub display_name: String,
    pub connected_at: String,
}

// ---------------------------------------------------------------------------
// connect
// ---------------------------------------------------------------------------

async fn connect(
    url: String,
    code: Option<String>,
    id: Option<String>,
    name: Option<String>,
) -> Result<()> {
    let cloud_url = normalize_cloud_url(&url)?;
    let code = match code {
        Some(code) => code,
        None => prompt_for_pairing_code()?,
    };
    let code = code.trim().to_string();
    if code.is_empty() {
        bail!("a pairing code is required (mint one from the workstation panel)");
    }

    let client = http_client()?;
    let redeem_url = format!("{cloud_url}/api/workstations/pairing-codes/redeem");
    let response = client
        .post(&redeem_url)
        .json(&serde_json::json!({ "code": code }))
        .send()
        .await
        .with_context(|| format!("could not reach {cloud_url}"))?;
    let status = response.status().as_u16();
    let body = response.text().await.unwrap_or_default();
    let credential = match parse_redeem_response(status, &body) {
        Ok(credential) => credential,
        Err(RedeemError::Rejected) => {
            eprintln!(
                "Pairing code is invalid, expired, or already used — mint a fresh one from the workstation panel."
            );
            std::process::exit(1);
        }
        Err(RedeemError::Unexpected(message)) => bail!("pairing code redeem failed: {message}"),
    };

    let hostname = runt_workspace::machine_hostname();
    let workstation_id = id.unwrap_or_else(|| runt_workspace::stable_workstation_id(&hostname));
    let display_name = name.unwrap_or(hostname);
    let credentials = WorkstationCredentialFile {
        cloud_url: cloud_url.clone(),
        token: credential.token,
        credential_id: credential.credential_id,
        workstation_id: workstation_id.clone(),
        display_name: display_name.clone(),
        connected_at: chrono::Utc::now().to_rfc3339(),
    };
    let path = runt_workspace::workstation_credentials_path();
    write_credential_file(&path, &credentials)?;
    println!("Workstation credential stored at {}", path.display());

    // One registration so the workstation appears in the panel (and the
    // pairing dialog flips to "registered") without waiting for `run`.
    let payload = minimal_registration_payload(
        &workstation_id,
        &display_name,
        std::env::current_dir()
            .ok()
            .map(|dir| dir.to_string_lossy().into_owned())
            .as_deref(),
        cpu_count(),
    );
    let registration = client
        .post(format!("{cloud_url}/api/workstations"))
        .bearer_auth(&credentials.token)
        .json(&payload)
        .send()
        .await;
    match registration {
        Ok(response) if response.status().is_success() => {
            println!(
                "Registered workstation \"{display_name}\" ({workstation_id}) with {cloud_url}."
            );
        }
        Ok(response) => {
            eprintln!(
                "Warning: registration returned HTTP {}; `{} workstation run` will retry.",
                response.status(),
                runt_workspace::cli_command_name()
            );
        }
        Err(error) => {
            eprintln!(
                "Warning: registration failed ({error}); `{} workstation run` will retry.",
                runt_workspace::cli_command_name()
            );
        }
    }

    println!(
        "Run `{} workstation run` to serve attach requests.",
        runt_workspace::cli_command_name()
    );
    Ok(())
}

fn prompt_for_pairing_code() -> Result<String> {
    eprint!("Enter pairing code (XXXX-XXXX-XXXX): ");
    std::io::stderr().flush().ok();
    let mut line = String::new();
    std::io::stdin()
        .read_line(&mut line)
        .context("failed to read pairing code from stdin")?;
    Ok(line.trim().to_string())
}

/// Redeem result: the long-lived workstation credential.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct RedeemedCredential {
    pub token: String,
    pub credential_id: String,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum RedeemError {
    /// 404: unknown, expired, and already-used codes are indistinguishable
    /// by design (the endpoint must not oracle live codes).
    Rejected,
    Unexpected(String),
}

/// Parse `POST /api/workstations/pairing-codes/redeem`. Success is
/// `201 {"ok":true,"credential":{"token":"nwc_...","credential_id":"..."},...}`.
pub(crate) fn parse_redeem_response(
    status: u16,
    body: &str,
) -> Result<RedeemedCredential, RedeemError> {
    if status == 404 {
        return Err(RedeemError::Rejected);
    }
    if status != 200 && status != 201 {
        let snippet: String = body.chars().take(300).collect();
        return Err(RedeemError::Unexpected(format!("HTTP {status} {snippet}")));
    }
    let value: serde_json::Value = serde_json::from_str(body)
        .map_err(|e| RedeemError::Unexpected(format!("invalid JSON response: {e}")))?;
    let token = value
        .pointer("/credential/token")
        .and_then(|v| v.as_str())
        .filter(|t| !t.is_empty());
    let credential_id = value
        .pointer("/credential/credential_id")
        .and_then(|v| v.as_str())
        .filter(|c| !c.is_empty());
    match (token, credential_id) {
        (Some(token), Some(credential_id)) => Ok(RedeemedCredential {
            token: token.to_string(),
            credential_id: credential_id.to_string(),
        }),
        _ => Err(RedeemError::Unexpected(
            "redeem response is missing credential.token / credential.credential_id".to_string(),
        )),
    }
}

/// Minimal registration payload for the one-shot `connect` registration.
/// (`runtimed workstation-agent` sends the full payload — python path,
/// capabilities, memory — on every heartbeat.)
pub(crate) fn minimal_registration_payload(
    workstation_id: &str,
    display_name: &str,
    working_directory: Option<&str>,
    cpu_count: Option<u64>,
) -> serde_json::Value {
    let mut payload = serde_json::json!({
        "workstation_id": workstation_id,
        "display_name": display_name,
        "provider": "runtime_peer",
        "environment_policy": "current_python",
        "default_environment_label": "Current Python",
    });
    if let Some(dir) = working_directory {
        payload["working_directory"] = dir.into();
    }
    if let Some(cpu) = cpu_count {
        payload["cpu_count"] = cpu.into();
    }
    payload
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

async fn run(python_path: Option<PathBuf>) -> Result<()> {
    let resolved = resolve_credentials()?;

    let runtimed_bin = locate_runtimed_binary().ok_or_else(|| {
        anyhow::anyhow!(
            "could not find a runtimed binary next to runt or in the installed app; \
             build one with `cargo build -p runtimed` or reinstall nteract"
        )
    })?;

    println!(
        "Serving attach requests for {} as {} (\"{}\") via {}",
        resolved.cloud_url,
        resolved.workstation_id,
        resolved.display_name,
        runtimed_bin.display()
    );
    if let Some(path) = &python_path {
        println!("Python interpreter: {}", path.display());
    }

    let mut command = std::process::Command::new(&runtimed_bin);
    command
        .args(workstation_agent_args(&resolved, python_path.as_deref()))
        // The credential rides the environment, never argv.
        .env(CLOUD_TOKEN_ENV, &resolved.token);

    let status = command
        .status()
        .with_context(|| format!("failed to launch {}", runtimed_bin.display()))?;

    std::process::exit(status.code().unwrap_or(1));
}

fn workstation_agent_args(
    resolved: &ResolvedCredentials,
    python_path: Option<&Path>,
) -> Vec<std::ffi::OsString> {
    let mut args = vec![
        "workstation-agent".into(),
        "--cloud-url".into(),
        resolved.cloud_url.as_str().into(),
        "--workstation-id".into(),
        resolved.workstation_id.as_str().into(),
        "--display-name".into(),
        resolved.display_name.as_str().into(),
    ];
    if let Some(path) = python_path {
        args.push("--python-path".into());
        args.push(path.as_os_str().into());
    }
    args
}

/// Credentials in effect: the stored file, with `RUNT_CLOUD_TOKEN` /
/// `RUNT_CLOUD_URL` environment overrides winning when set.
struct ResolvedCredentials {
    cloud_url: String,
    token: String,
    workstation_id: String,
    display_name: String,
}

fn resolve_credentials() -> Result<ResolvedCredentials> {
    let path = runt_workspace::workstation_credentials_path();
    let stored = read_credential_file(&path)?;
    let env_token = non_empty_env(CLOUD_TOKEN_ENV);
    let env_url = non_empty_env(CLOUD_URL_ENV);

    let token = env_token.or_else(|| stored.as_ref().map(|c| c.token.clone()));
    let cloud_url = env_url.or_else(|| stored.as_ref().map(|c| c.cloud_url.clone()));
    let (Some(token), Some(cloud_url)) = (token, cloud_url) else {
        bail!(
            "no workstation credential found at {} — run `{} workstation connect <url>` first \
             (or set {CLOUD_TOKEN_ENV} and {CLOUD_URL_ENV})",
            path.display(),
            runt_workspace::cli_command_name()
        );
    };

    let hostname = runt_workspace::machine_hostname();
    let workstation_id = stored
        .as_ref()
        .map(|c| c.workstation_id.clone())
        .unwrap_or_else(|| runt_workspace::stable_workstation_id(&hostname));
    let display_name = stored
        .as_ref()
        .map(|c| c.display_name.clone())
        .unwrap_or(hostname);

    Ok(ResolvedCredentials {
        cloud_url: normalize_cloud_url(&cloud_url)?,
        token,
        workstation_id,
        display_name,
    })
}

/// Find the runtimed binary: the bundled/sibling lookup `runt` already uses
/// for daemon management, with a dev fallback to the workspace target dir.
fn locate_runtimed_binary() -> Option<PathBuf> {
    if let Some(path) = crate::find_bundled_runtimed() {
        return Some(path);
    }
    if crate::is_dev_mode() {
        let binary_name = if cfg!(windows) {
            "runtimed.exe"
        } else {
            "runtimed"
        };
        if let Some(workspace) = runt_workspace::get_workspace_path() {
            for profile in ["debug", "release"] {
                let candidate = workspace.join("target").join(profile).join(binary_name);
                if candidate.exists() {
                    return Some(candidate);
                }
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

async fn status(json_output: bool) -> Result<()> {
    let resolved = resolve_credentials()?;
    let client = http_client()?;
    let response = client
        .get(format!("{}/api/workstations", resolved.cloud_url))
        .bearer_auth(&resolved.token)
        .send()
        .await
        .with_context(|| format!("could not reach {}", resolved.cloud_url))?;
    let status = response.status().as_u16();
    let body = response.text().await.unwrap_or_default();
    if status == 401 || status == 403 {
        bail!(
            "the workstation credential was rejected (HTTP {status}) — it may have been revoked; \
             run `{} workstation connect {}` with a fresh pairing code",
            runt_workspace::cli_command_name(),
            resolved.cloud_url
        );
    }
    if status != 200 {
        let snippet: String = body.chars().take(300).collect();
        bail!("listing workstations failed: HTTP {status} {snippet}");
    }
    let value: serde_json::Value =
        serde_json::from_str(&body).context("workstation list was not valid JSON")?;

    if json_output {
        println!("{}", serde_json::to_string_pretty(&value)?);
        return Ok(());
    }

    println!("Cloud: {}", resolved.cloud_url);
    println!(
        "This machine: {} (\"{}\")",
        resolved.workstation_id, resolved.display_name
    );
    println!();
    let workstations = value
        .get("workstations")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    if workstations.is_empty() {
        println!(
            "No workstations registered yet. Run `{} workstation run` to register.",
            runt_workspace::cli_command_name()
        );
        return Ok(());
    }
    println!(
        "{:<28} {:<24} {:<9} {:<25} DEFAULT",
        "WORKSTATION", "NAME", "STATUS", "LAST SEEN"
    );
    for workstation in &workstations {
        let field = |key: &str| {
            workstation
                .get(key)
                .and_then(|v| v.as_str())
                .unwrap_or("-")
                .to_string()
        };
        let is_default = workstation
            .get("is_default")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        println!(
            "{:<28} {:<24} {:<9} {:<25} {}",
            field("workstation_id"),
            field("display_name"),
            field("status"),
            field("last_seen_at"),
            if is_default { "*" } else { "" }
        );
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

fn http_client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .context("build HTTP client")
}

fn non_empty_env(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn normalize_cloud_url(url: &str) -> Result<String> {
    let url = url.trim().trim_end_matches('/').to_string();
    if !url.starts_with("https://") && !url.starts_with("http://") {
        bail!("cloud URL must start with https:// or http:// (got {url:?})");
    }
    Ok(url)
}

fn cpu_count() -> Option<u64> {
    std::thread::available_parallelism()
        .ok()
        .map(|n| n.get() as u64)
}

/// Write the credential file with owner-only permissions (0600 on unix).
pub(crate) fn write_credential_file(
    path: &Path,
    credentials: &WorkstationCredentialFile,
) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("create config directory {}", parent.display()))?;
    }
    let json = serde_json::to_string_pretty(credentials)?;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .with_context(|| format!("open credential file {}", path.display()))?;
    file.write_all(json.as_bytes())?;
    file.write_all(b"\n")?;
    // OpenOptions mode only applies on create — tighten a pre-existing file too.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .with_context(|| format!("set permissions on {}", path.display()))?;
    }
    Ok(())
}

/// Read the credential file; `Ok(None)` when it does not exist.
pub(crate) fn read_credential_file(path: &Path) -> Result<Option<WorkstationCredentialFile>> {
    match std::fs::read_to_string(path) {
        Ok(raw) => Ok(Some(serde_json::from_str(&raw).with_context(|| {
            format!("credential file {} is not valid JSON", path.display())
        })?)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => {
            Err(error).with_context(|| format!("read credential file {}", path.display()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_credentials() -> WorkstationCredentialFile {
        WorkstationCredentialFile {
            cloud_url: "https://preview.runt.run".to_string(),
            token: "nwc_secret".to_string(),
            credential_id: "cred-1".to_string(),
            workstation_id: "ws-lab2".to_string(),
            display_name: "lab2".to_string(),
            connected_at: "2026-06-12T00:00:00Z".to_string(),
        }
    }

    /// (a) Credential file round-trip, including owner-only permissions.
    #[test]
    fn credential_file_round_trip_with_0600_permissions() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("workstation.json");
        let credentials = sample_credentials();

        write_credential_file(&path, &credentials).unwrap();
        let loaded = read_credential_file(&path).unwrap().unwrap();
        assert_eq!(loaded, credentials);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "credential file must be 0600");
        }
    }

    #[test]
    fn credential_file_rewrites_tighten_permissions() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workstation.json");
        std::fs::write(&path, "{}").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        }

        write_credential_file(&path, &sample_credentials()).unwrap();

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    #[test]
    fn missing_credential_file_reads_as_none() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("does-not-exist.json");
        assert_eq!(read_credential_file(&path).unwrap(), None);
    }

    /// (b) Redeem response parsing: the 201 success shape from
    /// `routeWorkstationPairingCodeRedeem`.
    #[test]
    fn parse_redeem_success_shape() {
        let body = r#"{
            "ok": true,
            "credential": { "token": "nwc_abc123", "credential_id": "cred-9" },
            "pairing": { "id": "pairing-1" }
        }"#;
        assert_eq!(
            parse_redeem_response(201, body).unwrap(),
            RedeemedCredential {
                token: "nwc_abc123".to_string(),
                credential_id: "cred-9".to_string(),
            }
        );
    }

    /// (b) 404 means invalid/expired/used — indistinguishable by design.
    #[test]
    fn parse_redeem_404_is_rejected() {
        let body = r#"{"error":"pairing code is invalid, expired, or already used"}"#;
        assert_eq!(
            parse_redeem_response(404, body).unwrap_err(),
            RedeemError::Rejected
        );
    }

    #[test]
    fn parse_redeem_other_failures_are_unexpected() {
        assert!(matches!(
            parse_redeem_response(500, "boom"),
            Err(RedeemError::Unexpected(message)) if message.contains("HTTP 500")
        ));
        assert!(matches!(
            parse_redeem_response(201, "not json"),
            Err(RedeemError::Unexpected(message)) if message.contains("invalid JSON")
        ));
        assert!(matches!(
            parse_redeem_response(201, r#"{"ok":true}"#),
            Err(RedeemError::Unexpected(message)) if message.contains("missing credential")
        ));
    }

    #[test]
    fn minimal_registration_payload_field_set() {
        let payload =
            minimal_registration_payload("ws-lab2", "lab2", Some("/home/ubuntu/project"), Some(8));
        assert_eq!(
            payload,
            serde_json::json!({
                "workstation_id": "ws-lab2",
                "display_name": "lab2",
                "provider": "runtime_peer",
                "environment_policy": "current_python",
                "default_environment_label": "Current Python",
                "working_directory": "/home/ubuntu/project",
                "cpu_count": 8,
            })
        );

        let sparse = minimal_registration_payload("ws", "ws", None, None);
        assert!(sparse.get("working_directory").is_none());
        assert!(sparse.get("cpu_count").is_none());
    }

    #[test]
    fn workstation_agent_args_include_python_path_override_without_token() {
        let resolved = ResolvedCredentials {
            cloud_url: "https://preview.runt.run".to_string(),
            token: "nwc_secret".to_string(),
            workstation_id: "ws-lab2".to_string(),
            display_name: "lab2".to_string(),
        };

        let args = workstation_agent_args(&resolved, Some(Path::new("/home/ubuntu/k/bin/python")));
        let rendered = args
            .iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();

        assert_eq!(
            rendered,
            vec![
                "workstation-agent",
                "--cloud-url",
                "https://preview.runt.run",
                "--workstation-id",
                "ws-lab2",
                "--display-name",
                "lab2",
                "--python-path",
                "/home/ubuntu/k/bin/python",
            ]
        );
        assert!(!rendered.iter().any(|arg| arg.contains("nwc_secret")));
    }

    #[test]
    fn workstation_agent_args_omit_python_path_when_not_overridden() {
        let resolved = ResolvedCredentials {
            cloud_url: "https://preview.runt.run".to_string(),
            token: "nwc_secret".to_string(),
            workstation_id: "ws-lab2".to_string(),
            display_name: "lab2".to_string(),
        };

        let args = workstation_agent_args(&resolved, None);
        let rendered = args
            .iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();

        assert!(!rendered.iter().any(|arg| arg == "--python-path"));
        assert!(!rendered.iter().any(|arg| arg.contains("nwc_secret")));
    }

    #[test]
    fn cloud_url_normalization() {
        assert_eq!(
            normalize_cloud_url("https://app.runt.run/").unwrap(),
            "https://app.runt.run"
        );
        assert!(normalize_cloud_url("app.runt.run").is_err());
    }
}
