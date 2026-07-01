//! `runt workstation` — pair this machine with a hosted nteract cloud and
//! serve attach requests.
//!
//! The operator path (`docs/runbooks/remote-workstation.md`, ADR
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
#[cfg(target_os = "linux")]
use std::process::{Command, Stdio};
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
        /// Working directory advertised for this workstation and used for
        /// runtime peers unless an attach job overrides it.
        #[arg(long, alias = "cwd")]
        working_directory: Option<PathBuf>,
    },
    /// Manage the persistent workstation agent service
    Service {
        #[command(subcommand)]
        command: WorkstationServiceCommands,
    },
    /// List workstations registered to the stored credential
    Status {
        /// Output raw JSON
        #[arg(long)]
        json: bool,
    },
}

#[derive(clap::Subcommand)]
pub enum WorkstationServiceCommands {
    /// Install the user systemd service for the workstation agent
    Install {
        /// Python interpreter used for launch-on-attach kernels.
        #[arg(long)]
        python_path: Option<PathBuf>,
        /// Working directory advertised for this workstation and used for
        /// runtime peers unless an attach job overrides it. Defaults to the
        /// current directory at install time.
        #[arg(long, alias = "cwd")]
        working_directory: Option<PathBuf>,
        /// Start the service after writing and enabling it.
        #[arg(long)]
        start: bool,
    },
    /// Start the workstation service
    Start,
    /// Stop the workstation service
    Stop,
    /// Show workstation service status
    Status,
    /// Show workstation service logs from the user journal
    Logs {
        /// Follow the log (like journalctl -f)
        #[arg(short, long)]
        follow: bool,
        /// Number of lines to show
        #[arg(short = 'n', long, default_value = "50")]
        lines: usize,
    },
    /// Disable and remove the workstation service
    Uninstall,
}

pub async fn command(command: WorkstationCommands) -> Result<()> {
    match command {
        WorkstationCommands::Connect {
            url,
            code,
            id,
            name,
        } => connect(url, code, id, name).await,
        WorkstationCommands::Run {
            python_path,
            working_directory,
        } => run(python_path, working_directory).await,
        WorkstationCommands::Service { command } => service(command).await,
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

    let cli = runt_workspace::cli_command_name();
    println!("To serve attach requests in this terminal:");
    println!("  {cli} workstation run");
    #[cfg(target_os = "linux")]
    {
        println!("To keep this workstation available with user systemd:");
        println!("  {cli} workstation service install --start");
    }
    #[cfg(not(target_os = "linux"))]
    {
        println!(
            "Persistent workstation service management starts with Linux user systemd; use the foreground command in tmux for now."
        );
    }
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

async fn run(python_path: Option<PathBuf>, working_directory: Option<PathBuf>) -> Result<()> {
    let resolved = resolve_credentials()?;
    let working_directory = match working_directory {
        Some(path) => Some(resolve_existing_directory(&path)?),
        None => None,
    };

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
    if let Some(path) = &working_directory {
        println!("Working directory: {}", path.display());
    }

    let mut command = std::process::Command::new(&runtimed_bin);
    command
        .args(workstation_agent_args(
            &resolved,
            python_path.as_deref(),
            working_directory.as_deref(),
        ))
        // The credential rides the environment, never argv.
        .env(CLOUD_TOKEN_ENV, &resolved.token);
    if let Some(path) = &working_directory {
        command.current_dir(path);
    }

    let status = command
        .status()
        .with_context(|| format!("failed to launch {}", runtimed_bin.display()))?;

    std::process::exit(status.code().unwrap_or(1));
}

fn workstation_agent_args(
    resolved: &ResolvedCredentials,
    python_path: Option<&Path>,
    working_directory: Option<&Path>,
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
    if let Some(path) = working_directory {
        args.push("--working-dir".into());
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
// service
// ---------------------------------------------------------------------------

async fn service(command: WorkstationServiceCommands) -> Result<()> {
    #[cfg(target_os = "linux")]
    {
        service_linux(command)
    }

    #[cfg(not(target_os = "linux"))]
    {
        let _ = command;
        bail!(
            "workstation service management currently supports Linux user systemd only. \
             Use `{} workstation run` in tmux for foreground/manual testing.",
            runt_workspace::cli_command_name()
        )
    }
}

#[cfg(target_os = "linux")]
fn service_linux(command: WorkstationServiceCommands) -> Result<()> {
    match command {
        WorkstationServiceCommands::Install {
            python_path,
            working_directory,
            start,
        } => install_workstation_service(python_path, working_directory, start),
        WorkstationServiceCommands::Start => start_workstation_service(),
        WorkstationServiceCommands::Stop => stop_workstation_service(),
        WorkstationServiceCommands::Status => status_workstation_service(),
        WorkstationServiceCommands::Logs { follow, lines } => {
            logs_workstation_service(follow, lines)
        }
        WorkstationServiceCommands::Uninstall => uninstall_workstation_service(),
    }
}

#[cfg(any(target_os = "linux", test))]
#[derive(Debug, Clone)]
struct WorkstationServiceUnitConfig {
    runt_path: PathBuf,
    python_path: Option<PathBuf>,
    working_directory: PathBuf,
    home: PathBuf,
}

#[cfg(target_os = "linux")]
fn workstation_service_unit_name() -> String {
    format!("{}-workstation.service", runt_workspace::config_namespace())
}

#[cfg(target_os = "linux")]
fn workstation_service_path() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join("systemd")
        .join("user")
        .join(workstation_service_unit_name())
}

#[cfg(any(target_os = "linux", test))]
fn workstation_service_run_args(config: &WorkstationServiceUnitConfig) -> Vec<String> {
    let mut args = vec![
        config.runt_path.to_string_lossy().into_owned(),
        "workstation".to_string(),
        "run".to_string(),
    ];
    if let Some(path) = &config.python_path {
        args.push("--python-path".to_string());
        args.push(path.to_string_lossy().into_owned());
    }
    args.push("--working-directory".to_string());
    args.push(config.working_directory.to_string_lossy().into_owned());
    args
}

#[cfg(any(target_os = "linux", test))]
fn render_workstation_systemd_unit(config: &WorkstationServiceUnitConfig) -> String {
    let home = config.home.to_string_lossy();
    let path = format!("{home}/.local/bin:/usr/local/bin:/usr/bin:/bin");
    let exec_start = workstation_service_run_args(config)
        .iter()
        .map(|arg| systemd_quote_exec_arg(arg))
        .collect::<Vec<_>>()
        .join(" ");
    format!(
        r#"[Unit]
Description=nteract workstation agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart={exec_start}
WorkingDirectory={working_directory}
Restart=on-failure
RestartSec=5
Environment={home_env}
Environment={path_env}

[Install]
WantedBy=default.target
"#,
        exec_start = exec_start,
        working_directory = systemd_quote_unit_value(&config.working_directory.to_string_lossy()),
        home_env = systemd_quote_unit_value(&format!("HOME={home}")),
        path_env = systemd_quote_unit_value(&format!("PATH={path}")),
    )
}

#[cfg(any(target_os = "linux", test))]
fn systemd_quote_exec_arg(value: &str) -> String {
    systemd_quote(value, true)
}

#[cfg(any(target_os = "linux", test))]
fn systemd_quote_unit_value(value: &str) -> String {
    systemd_quote(value, false)
}

#[cfg(any(target_os = "linux", test))]
fn systemd_quote(value: &str, escape_dollar: bool) -> String {
    let mut escaped = String::with_capacity(value.len() + 2);
    escaped.push('"');
    for ch in value.chars() {
        match ch {
            '\\' => escaped.push_str("\\\\"),
            '"' => escaped.push_str("\\\""),
            '$' if escape_dollar => escaped.push_str("$$"),
            '$' => escaped.push('$'),
            '%' => escaped.push_str("%%"),
            '\n' => escaped.push_str("\\n"),
            '\r' => escaped.push_str("\\r"),
            '\t' => escaped.push_str("\\t"),
            _ => escaped.push(ch),
        }
    }
    escaped.push('"');
    escaped
}

fn resolve_existing_directory(path: &Path) -> Result<PathBuf> {
    let resolved =
        std::fs::canonicalize(path).with_context(|| format!("resolve {}", path.display()))?;
    if !resolved.is_dir() {
        bail!("{} is not a directory", resolved.display());
    }
    Ok(resolved)
}

#[cfg(target_os = "linux")]
fn install_workstation_service(
    python_path: Option<PathBuf>,
    working_directory: Option<PathBuf>,
    start: bool,
) -> Result<()> {
    ensure_user_systemd_available()?;
    ensure_stored_workstation_credential()?;
    let service_path = workstation_service_path();
    let working_directory = match working_directory {
        Some(path) => resolve_existing_directory(&path)?,
        None => resolve_existing_directory(&std::env::current_dir().context("resolve cwd")?)?,
    };
    let runt_path = current_runt_path_for_service()?;
    let home =
        dirs::home_dir().ok_or_else(|| anyhow::anyhow!("cannot determine home directory"))?;
    let config = WorkstationServiceUnitConfig {
        runt_path,
        python_path,
        working_directory,
        home,
    };
    if let Some(parent) = service_path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("create systemd user directory {}", parent.display()))?;
    }
    std::fs::write(&service_path, render_workstation_systemd_unit(&config))
        .with_context(|| format!("write {}", service_path.display()))?;
    systemctl_checked(&["daemon-reload"], "reload user systemd")?;
    systemctl_checked(
        &["enable", &workstation_service_unit_name()],
        "enable workstation service",
    )?;
    println!(
        "Installed workstation service at {}",
        service_path.display()
    );
    println!(
        "It runs `{}` using the stored workstation credential.",
        config.runt_path.display()
    );
    if start {
        start_or_restart_workstation_service_after_install()?;
    } else {
        println!(
            "Start it with `{} workstation service start`.",
            runt_workspace::cli_command_name()
        );
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn start_or_restart_workstation_service_after_install() -> Result<()> {
    ensure_user_systemd_available()?;
    ensure_workstation_service_installed()?;
    let active_state = systemctl_probe(&["is-active", &workstation_service_unit_name()]);
    let action = workstation_service_start_action_for_active_state(&active_state);
    systemctl_checked(
        &[action, &workstation_service_unit_name()],
        if action == "restart" {
            "restart workstation service"
        } else {
            "start workstation service"
        },
    )?;
    println!(
        "Workstation service {}.",
        if action == "restart" {
            "restarted"
        } else {
            "started"
        }
    );
    Ok(())
}

#[cfg(any(target_os = "linux", test))]
fn workstation_service_start_action_for_active_state(active_state: &str) -> &'static str {
    if active_state.trim() == "active" {
        "restart"
    } else {
        "start"
    }
}

#[cfg(target_os = "linux")]
fn start_workstation_service() -> Result<()> {
    ensure_user_systemd_available()?;
    ensure_workstation_service_installed()?;
    systemctl_checked(
        &["start", &workstation_service_unit_name()],
        "start workstation service",
    )?;
    println!("Workstation service started.");
    Ok(())
}

#[cfg(target_os = "linux")]
fn stop_workstation_service() -> Result<()> {
    ensure_user_systemd_available()?;
    if !workstation_service_path().exists() {
        println!("Workstation service is not installed.");
        return Ok(());
    }
    systemctl_checked(
        &["stop", &workstation_service_unit_name()],
        "stop workstation service",
    )?;
    println!("Workstation service stopped.");
    Ok(())
}

#[cfg(target_os = "linux")]
fn status_workstation_service() -> Result<()> {
    ensure_user_systemd_available()?;
    let service_path = workstation_service_path();
    println!("Unit: {}", workstation_service_unit_name());
    println!("File: {}", service_path.display());
    if !service_path.exists() {
        println!("Installed: no");
        println!(
            "Run `{} workstation service install --start` after pairing this machine.",
            runt_workspace::cli_command_name()
        );
        return Ok(());
    }
    println!("Installed: yes");
    println!(
        "Enabled: {}",
        systemctl_probe(&["is-enabled", &workstation_service_unit_name()])
    );
    println!(
        "Active: {}",
        systemctl_probe(&["is-active", &workstation_service_unit_name()])
    );
    Ok(())
}

#[cfg(target_os = "linux")]
fn logs_workstation_service(follow: bool, lines: usize) -> Result<()> {
    ensure_user_systemd_available()?;
    ensure_workstation_service_installed()?;
    let mut command = journalctl_command();
    command
        .args(["--user", "-u"])
        .arg(workstation_service_unit_name())
        .args(["--no-pager", "-n"])
        .arg(lines.to_string());
    if follow {
        command.arg("-f");
    }
    let status = command.status().context("run journalctl")?;
    if !status.success() {
        bail!(
            "journalctl failed for {}; run `{} workstation service status` first",
            workstation_service_unit_name(),
            runt_workspace::cli_command_name()
        );
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn uninstall_workstation_service() -> Result<()> {
    ensure_user_systemd_available()?;
    let service_path = workstation_service_path();
    if !service_path.exists() {
        println!("Workstation service is not installed.");
        return Ok(());
    }
    systemctl_best_effort(&["stop", &workstation_service_unit_name()]);
    systemctl_best_effort(&["disable", &workstation_service_unit_name()]);
    std::fs::remove_file(&service_path)
        .with_context(|| format!("remove {}", service_path.display()))?;
    systemctl_checked(&["daemon-reload"], "reload user systemd")?;
    println!("Workstation service uninstalled.");
    Ok(())
}

#[cfg(target_os = "linux")]
fn ensure_stored_workstation_credential() -> Result<()> {
    let path = runt_workspace::workstation_credentials_path();
    let Some(credentials) = read_credential_file(&path)? else {
        bail!(
            "no stored workstation credential found at {}. Run `{} workstation connect <url>` first.",
            path.display(),
            runt_workspace::cli_command_name()
        );
    };
    if credentials.token.trim().is_empty() || credentials.cloud_url.trim().is_empty() {
        bail!(
            "workstation credential at {} is incomplete. Run `{} workstation connect <url>` again.",
            path.display(),
            runt_workspace::cli_command_name()
        );
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn ensure_workstation_service_installed() -> Result<()> {
    if workstation_service_path().exists() {
        return Ok(());
    }
    bail!(
        "workstation service is not installed. Run `{} workstation service install --start` after pairing this machine.",
        runt_workspace::cli_command_name()
    );
}

#[cfg(target_os = "linux")]
fn current_runt_path_for_service() -> Result<PathBuf> {
    let path = std::env::current_exe().context("resolve current runt executable")?;
    let path = std::fs::canonicalize(&path).unwrap_or(path);
    if !path.exists() {
        bail!(
            "current runt executable does not exist at {}",
            path.display()
        );
    }
    Ok(path)
}

#[cfg(target_os = "linux")]
fn ensure_user_systemd_available() -> Result<()> {
    let output = match systemctl_command()
        .args(["--user", "show-environment"])
        .output()
    {
        Ok(output) => output,
        Err(error) => {
            let detail = if error.kind() == std::io::ErrorKind::NotFound {
                "systemctl was not found on this host".to_string()
            } else {
                format!("could not run systemctl --user show-environment: {error}")
            };
            bail!("{}", user_systemd_unavailable_message(&detail));
        }
    };
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let detail = [stderr.trim(), stdout.trim()]
        .into_iter()
        .find(|value| !value.is_empty())
        .unwrap_or("systemctl --user did not report details");
    bail!("{}", user_systemd_unavailable_message(detail));
}

#[cfg(any(target_os = "linux", test))]
fn user_systemd_unavailable_message(detail: &str) -> String {
    format!(
        "Linux user systemd is not available in this session: {detail}\n\
         Use a normal login session with XDG_RUNTIME_DIR/DBus available, or ask an admin to enable lingering with `loginctl enable-linger $USER` if this workstation should stay available after logout.\n\
         Fallback: run `{} workstation run` inside tmux.",
        runt_workspace::cli_command_name()
    )
}

#[cfg(target_os = "linux")]
const APPIMAGE_HOST_ENV_VARS: &[&str] = &[
    "APPDIR",
    "APPIMAGE",
    "ARGV0",
    "LD_AUDIT",
    "LD_DEBUG",
    "LD_LIBRARY_PATH",
    "LD_ORIGIN_PATH",
    "LD_PRELOAD",
    "OWD",
];

#[cfg(target_os = "linux")]
fn systemctl_binary() -> &'static str {
    if Path::new("/usr/bin/systemctl").exists() {
        "/usr/bin/systemctl"
    } else if Path::new("/bin/systemctl").exists() {
        "/bin/systemctl"
    } else {
        "systemctl"
    }
}

#[cfg(target_os = "linux")]
fn journalctl_binary() -> &'static str {
    if Path::new("/usr/bin/journalctl").exists() {
        "/usr/bin/journalctl"
    } else if Path::new("/bin/journalctl").exists() {
        "/bin/journalctl"
    } else {
        "journalctl"
    }
}

#[cfg(target_os = "linux")]
fn strip_appimage_host_env(command: &mut Command) {
    for var in APPIMAGE_HOST_ENV_VARS {
        command.env_remove(var);
    }
}

#[cfg(target_os = "linux")]
fn systemctl_command() -> Command {
    let mut command = Command::new(systemctl_binary());
    strip_appimage_host_env(&mut command);
    command
}

#[cfg(target_os = "linux")]
fn journalctl_command() -> Command {
    let mut command = Command::new(journalctl_binary());
    strip_appimage_host_env(&mut command);
    command
}

#[cfg(target_os = "linux")]
fn systemctl_checked(args: &[&str], action: &str) -> Result<()> {
    let output = systemctl_command()
        .arg("--user")
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .with_context(|| format!("systemctl --user {}", args.join(" ")))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let detail = [stderr.trim(), stdout.trim()]
        .into_iter()
        .find(|value| !value.is_empty())
        .unwrap_or("systemctl did not report details");
    bail!(
        "failed to {action}: {detail}\nRun `{} workstation service status` for current state, or use `{} workstation run` in tmux.",
        runt_workspace::cli_command_name(),
        runt_workspace::cli_command_name()
    );
}

#[cfg(target_os = "linux")]
fn systemctl_best_effort(args: &[&str]) {
    let _ = systemctl_command().arg("--user").args(args).output();
}

#[cfg(target_os = "linux")]
fn systemctl_probe(args: &[&str]) -> String {
    match systemctl_command().arg("--user").args(args).output() {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            let value = [stdout.trim(), stderr.trim()]
                .into_iter()
                .find(|value| !value.is_empty())
                .unwrap_or("unknown");
            value.to_string()
        }
        Err(error) => format!("unknown ({error})"),
    }
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

        let args = workstation_agent_args(
            &resolved,
            Some(Path::new("/home/ubuntu/k/bin/python")),
            None,
        );
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

        let args = workstation_agent_args(&resolved, None, None);
        let rendered = args
            .iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();

        assert!(!rendered.iter().any(|arg| arg == "--python-path"));
        assert!(!rendered.iter().any(|arg| arg.contains("nwc_secret")));
    }

    #[test]
    fn workstation_agent_args_include_working_directory_without_token() {
        let resolved = ResolvedCredentials {
            cloud_url: "https://preview.runt.run".to_string(),
            token: "nwc_secret".to_string(),
            workstation_id: "ws-lab2".to_string(),
            display_name: "lab2".to_string(),
        };

        let args = workstation_agent_args(
            &resolved,
            None,
            Some(Path::new("/home/ubuntu/project with spaces")),
        );
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
                "--working-dir",
                "/home/ubuntu/project with spaces",
            ]
        );
        assert!(!rendered.iter().any(|arg| arg.contains("nwc_secret")));
    }

    #[test]
    fn workstation_service_unit_runs_public_cli_without_token() {
        let config = WorkstationServiceUnitConfig {
            runt_path: PathBuf::from("/home/ubuntu/.local/bin/runt"),
            python_path: Some(PathBuf::from("/home/ubuntu/project/.venv/bin/python")),
            working_directory: PathBuf::from("/home/ubuntu/project"),
            home: PathBuf::from("/home/ubuntu"),
        };

        let unit = render_workstation_systemd_unit(&config);

        assert!(unit.contains("Description=nteract workstation agent"));
        assert!(unit.contains(
            "ExecStart=\"/home/ubuntu/.local/bin/runt\" \"workstation\" \"run\" \"--python-path\" \"/home/ubuntu/project/.venv/bin/python\" \"--working-directory\" \"/home/ubuntu/project\""
        ));
        assert!(unit.contains("WorkingDirectory=\"/home/ubuntu/project\""));
        assert!(unit.contains("Restart=on-failure"));
        assert!(unit.contains("Environment=\"HOME=/home/ubuntu\""));
        assert!(unit
            .contains("Environment=\"PATH=/home/ubuntu/.local/bin:/usr/local/bin:/usr/bin:/bin\""));
        assert!(!unit.contains("nwc_secret"));
        assert!(!unit.contains("RUNT_CLOUD_TOKEN"));
    }

    #[test]
    fn workstation_service_unit_escapes_systemd_specials() {
        let config = WorkstationServiceUnitConfig {
            runt_path: PathBuf::from("/home/u/bin/runt"),
            python_path: None,
            working_directory: PathBuf::from("/home/u/project %demo/$run/\"quoted\""),
            home: PathBuf::from("/home/u/$account"),
        };

        let unit = render_workstation_systemd_unit(&config);

        assert!(unit.contains(
            "ExecStart=\"/home/u/bin/runt\" \"workstation\" \"run\" \"--working-directory\" \"/home/u/project %%demo/$$run/\\\"quoted\\\"\""
        ));
        assert!(unit.contains("WorkingDirectory=\"/home/u/project %%demo/$run/\\\"quoted\\\"\""));
        assert!(unit.contains("Environment=\"HOME=/home/u/$account\""));
        assert!(unit.contains(
            "Environment=\"PATH=/home/u/$account/.local/bin:/usr/local/bin:/usr/bin:/bin\""
        ));
    }

    #[test]
    fn workstation_service_install_start_restarts_only_active_units() {
        assert_eq!(
            workstation_service_start_action_for_active_state("active\n"),
            "restart"
        );
        assert_eq!(
            workstation_service_start_action_for_active_state("inactive\n"),
            "start"
        );
        assert_eq!(
            workstation_service_start_action_for_active_state("failed\n"),
            "start"
        );
        assert_eq!(
            workstation_service_start_action_for_active_state("unknown"),
            "start"
        );
    }

    #[test]
    fn user_systemd_unavailable_message_includes_tmux_fallback() {
        let message = user_systemd_unavailable_message("systemctl was not found on this host");
        let fallback = format!(
            "Fallback: run `{} workstation run` inside tmux.",
            runt_workspace::cli_command_name()
        );

        assert!(message.contains(
            "Linux user systemd is not available in this session: systemctl was not found on this host"
        ));
        assert!(message.contains(&fallback));
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
