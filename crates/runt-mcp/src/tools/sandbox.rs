//! Sandbox MCP tools: list_credentials, get_notebook_sandbox_profile,
//! set_notebook_sandbox_profile, and get_sandbox_status.
//!
//! These tools give AI agents read/write access to the notebook sandbox
//! profile and credential discovery, per the constraints in decisions.md:
//! - D-9: agents can *read* credential names, never values; no create/delete
//! - D-10: agents must pre-declare full allowlists (no in-flight prompts)

use notebook_doc::sandbox::SandboxProfile;
use notebook_protocol::protocol::{NotebookRequest, NotebookResponse, SandboxStateInfo};
use rmcp::model::{CallToolRequestParams, CallToolResult};
use rmcp::ErrorData as McpError;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::NteractMcp;

use super::{tool_error, tool_success};

// ── Shared DTO ────────────────────────────────────────────────────────────────

/// Annotation from a sandbox event associated with a cell execution.
///
/// Surfaced in execution-result responses as `sandbox_event` when the daemon
/// has correlated a sandbox signal (domain block, credential error, proxy
/// degradation) with the execution.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct CellAnnotationDto {
    /// Short machine-readable tag, e.g. `"sandbox_http_block"`,
    /// `"sandbox_credential_missing"`, `"sandbox_proxy_degraded"`.
    pub kind: String,
    /// Human-readable enrichment message.
    pub message: String,
    /// Optional structured JSON details.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
}

impl From<&runtime_doc::CellAnnotation> for CellAnnotationDto {
    fn from(a: &runtime_doc::CellAnnotation) -> Self {
        CellAnnotationDto {
            kind: a.kind.clone(),
            message: a.message.clone(),
            details: a.details.clone(),
        }
    }
}

// ── 1. list_credentials ───────────────────────────────────────────────────────

/// No arguments for `list_credentials`.
#[allow(dead_code)]
#[derive(Debug, Deserialize, JsonSchema)]
pub struct ListCredentialsParams {}

/// A single credential entry in the `list_credentials` response.
#[derive(Debug, Serialize, JsonSchema)]
struct CredentialInfo {
    /// Credential name (never the value).
    name: String,
    /// True if the credential was found in the macOS Keychain via
    /// `security find-generic-password -s nono -a <name>`.
    keychain_present: bool,
    /// True if at least one open notebook's sandbox profile references
    /// this credential name.
    referenced_by_notebook: bool,
    /// Description from the first notebook profile that references this
    /// credential and provides a non-empty description.
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
}

/// List credentials the daemon is aware of.
///
/// Two sources are combined:
/// 1. Credential names referenced by the current notebook's sandbox profile.
/// 2. Names present in the macOS Keychain under the `nono` service prefix
///    (soft enumeration via `security find-generic-password`).
///
/// **This tool never returns credential values.**
pub async fn list_credentials(
    server: &NteractMcp,
    _request: &CallToolRequestParams,
) -> Result<CallToolResult, McpError> {
    // Collect profile-referenced credentials from the active notebook session.
    let mut credential_map: std::collections::HashMap<String, CredentialInfo> =
        std::collections::HashMap::new();

    if let Some(session) = server.session.read().await.as_ref() {
        let profile: Option<SandboxProfile> = session
            .handle
            .with_metadata(|snap| snap.runt.sandbox.clone())
            .unwrap_or(None);
        if let Some(profile) = profile {
            for cred in &profile.credentials {
                let entry =
                    credential_map
                        .entry(cred.name.clone())
                        .or_insert_with(|| CredentialInfo {
                            name: cred.name.clone(),
                            keychain_present: false,
                            referenced_by_notebook: true,
                            description: None,
                        });
                entry.referenced_by_notebook = true;
                if entry.description.is_none() {
                    entry.description = cred.description.clone().filter(|d| !d.is_empty());
                }
            }
        }
    }

    // Soft-enumerate the macOS Keychain for entries with service = "nono".
    // Only supported on macOS; silently skipped on other platforms.
    #[cfg(target_os = "macos")]
    {
        if let Ok(output) = tokio::process::Command::new("security")
            .args(["dump-keychain"])
            .output()
            .await
        {
            // Parse names from keychain dump — look for lines like:
            //   "acct"<blob>="analytics_api"
            // where the service attribute starts with "nono".
            let stdout = String::from_utf8_lossy(&output.stdout);
            let nono_names = parse_nono_keychain_names(&stdout);
            for name in nono_names {
                let entry = credential_map
                    .entry(name.clone())
                    .or_insert_with(|| CredentialInfo {
                        name: name.clone(),
                        keychain_present: false,
                        referenced_by_notebook: false,
                        description: None,
                    });
                entry.keychain_present = true;
            }
        }
    }

    // For profile-referenced credentials, verify each one individually.
    let profile_names: Vec<String> = credential_map
        .keys()
        .filter(|n| {
            credential_map
                .get(*n)
                .map(|e| e.referenced_by_notebook)
                .unwrap_or(false)
        })
        .cloned()
        .collect();
    for name in &profile_names {
        let present = check_keychain_credential(name).await;
        if let Some(entry) = credential_map.get_mut(name) {
            entry.keychain_present = present;
        }
    }

    let mut credentials: Vec<CredentialInfo> = credential_map.into_values().collect();
    credentials.sort_by(|a, b| a.name.cmp(&b.name));

    let response = serde_json::json!({ "credentials": credentials });
    let text = serde_json::to_string_pretty(&response)
        .unwrap_or_else(|_| "{\"credentials\":[]}".to_string());
    tool_success(&text)
}

/// Check if a single credential is present in the macOS Keychain.
/// Returns `false` on non-macOS or on any error.
async fn check_keychain_credential(name: &str) -> bool {
    #[cfg(target_os = "macos")]
    {
        tokio::process::Command::new("security")
            .args(["find-generic-password", "-s", "nono", "-a", name, "-g"])
            .output()
            .await
            .map(|o| o.status.success())
            .unwrap_or(false)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = name;
        false
    }
}

/// Parse account names for `nono` service entries from a `security
/// dump-keychain` output.
///
/// Looks for blocks containing `"svce"<blob>="nono"` and extracts the
/// corresponding `"acct"<blob>="<name>"` value.
#[cfg(target_os = "macos")]
fn parse_nono_keychain_names(dump: &str) -> Vec<String> {
    let mut names = Vec::new();
    // Split on keychain entry boundaries ("keychain:" or blank line runs).
    // A simpler heuristic: look for consecutive lines with svce=nono and acct=<name>.
    let mut current_acct: Option<String> = None;
    let mut current_svce_is_nono = false;
    for line in dump.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix(r#""svce"<blob>="#) {
            let svce = rest.trim_matches('"');
            current_svce_is_nono = svce.starts_with("nono");
        }
        if let Some(rest) = line.strip_prefix(r#""acct"<blob>="#) {
            let acct = rest.trim_matches('"').to_string();
            current_acct = Some(acct);
        }
        // A new keychain entry starts with a line containing "keychain: " or
        // a blank class line. When we see both svce and acct, record and reset.
        if current_svce_is_nono {
            if let Some(acct) = current_acct.take() {
                if !acct.is_empty() {
                    names.push(acct);
                }
                current_svce_is_nono = false;
            }
        }
    }
    names
}

// ── 2. get_notebook_sandbox_profile ──────────────────────────────────────────

/// Parameters for `get_notebook_sandbox_profile`.
#[allow(dead_code)]
#[derive(Debug, Deserialize, JsonSchema)]
pub struct GetNotebookSandboxProfileParams {
    /// Notebook UUID to read the sandbox profile for.
    /// Omit to use the current active session's notebook.
    #[serde(default)]
    pub notebook_id: Option<String>,
}

/// Read the current sandbox profile for the active notebook.
pub async fn get_notebook_sandbox_profile(
    server: &NteractMcp,
    _request: &CallToolRequestParams,
) -> Result<CallToolResult, McpError> {
    let handle = require_handle!(server);

    // Read the sandbox profile from notebook metadata via with_metadata.
    let profile: Option<SandboxProfile> = handle
        .with_metadata(|snap| snap.runt.sandbox.clone())
        .unwrap_or(None);

    let response = serde_json::json!({ "profile": profile });
    let text = serde_json::to_string_pretty(&response).unwrap_or_default();
    tool_success(&text)
}

// ── 3. set_notebook_sandbox_profile ──────────────────────────────────────────

/// Parameters for `set_notebook_sandbox_profile`.
#[allow(dead_code)]
#[derive(Debug, Deserialize, JsonSchema)]
pub struct SetNotebookSandboxProfileParams {
    /// New sandbox profile to write as a JSON object, or `null` to remove
    /// the profile. The profile must contain `enabled`, `credentials`, and
    /// optionally `allowed_domains`.
    pub profile: Option<serde_json::Value>,
}

/// Write (or remove) the sandbox profile for the active notebook.
///
/// Validates the profile before writing. Returns validation errors without
/// modifying the document if validation fails.  On success, returns any
/// credential names referenced by the profile that are not currently
/// present in the macOS Keychain (a soft warning — the write still happens).
pub async fn set_notebook_sandbox_profile(
    server: &NteractMcp,
    request: &CallToolRequestParams,
) -> Result<CallToolResult, McpError> {
    let handle = require_handle!(server);

    // Parse the optional `profile` argument from raw JSON.
    let profile: Option<SandboxProfile> =
        match request.arguments.as_ref().and_then(|a| a.get("profile")) {
            None | Some(serde_json::Value::Null) => None,
            Some(v) => match serde_json::from_value(v.clone()) {
                Ok(p) => Some(p),
                Err(e) => {
                    return tool_error(&format!("Invalid sandbox profile JSON: {e}"));
                }
            },
        };

    // Validate before writing.
    if let Some(ref p) = profile {
        let errors: Vec<String> = p.validate().iter().map(|e| e.to_string()).collect();
        if !errors.is_empty() {
            let response = serde_json::json!({
                "validation_errors": errors,
                "missing_credentials": [],
            });
            let text = serde_json::to_string_pretty(&response).unwrap_or_default();
            return tool_success(&text);
        }
    }

    // Collect credential names to check against the Keychain.
    let cred_names: Vec<String> = profile
        .as_ref()
        .map(|p| p.credentials.iter().map(|c| c.name.clone()).collect())
        .unwrap_or_default();

    // Write the profile using `with_metadata` (already validated above).
    // Set `snap.runt.sandbox` directly — this is the same operation that
    // `write_sandbox_profile` performs after validation.
    let write_result = handle.with_metadata(|snap| {
        snap.runt.sandbox = profile;
    });

    if let Err(e) = write_result {
        return tool_error(&format!("Failed to write sandbox profile: {e}"));
    } // Check which credentials are missing from the Keychain.
    let mut missing_credentials: Vec<String> = Vec::new();
    for name in &cred_names {
        if !check_keychain_credential(name).await {
            missing_credentials.push(name.clone());
        }
    }

    let response = serde_json::json!({
        "validation_errors": [],
        "missing_credentials": missing_credentials,
    });
    let text = serde_json::to_string_pretty(&response).unwrap_or_default();
    tool_success(&text)
}

// ── 4. get_sandbox_status ─────────────────────────────────────────────────────

/// Parameters for `get_sandbox_status`.
#[allow(dead_code)]
#[derive(Debug, Deserialize, JsonSchema)]
pub struct GetSandboxStatusParams {
    /// Runtime / notebook UUID to query. Uses the active session when omitted.
    #[serde(default)]
    pub runtime_id: Option<String>,
}

/// Get the active sandbox state for the current notebook's runtime.
pub async fn get_sandbox_status(
    server: &NteractMcp,
    _request: &CallToolRequestParams,
) -> Result<CallToolResult, McpError> {
    let handle = require_handle!(server);

    // Send GetSandboxState to the daemon and map the response.
    let response = handle
        .send_request(NotebookRequest::GetSandboxState {})
        .await;

    let state_dto = match response {
        Ok(NotebookResponse::SandboxState { state }) => state,
        Ok(NotebookResponse::NoKernel {}) | Ok(NotebookResponse::Ok {}) => {
            SandboxStateInfo::Disabled
        }
        Ok(other) => {
            return tool_error(&format!(
                "Unexpected daemon response to GetSandboxState: {:?}",
                std::mem::discriminant(&other)
            ));
        }
        Err(e) => {
            return tool_error(&format!("Failed to query sandbox state: {e}"));
        }
    };

    let response_json = serde_json::json!({ "state": state_dto });
    let text = serde_json::to_string_pretty(&response_json).unwrap_or_default();
    tool_success(&text)
}

// ── sandbox_event helper (used by execution.rs) ───────────────────────────────

/// Look up the sandbox annotation for a given execution ID from RuntimeStateDoc.
///
/// Returns `None` when the runtime has no annotation for this execution (the
/// common case for non-sandboxed notebooks and clean executions).
pub fn lookup_sandbox_event(
    handle: &notebook_sync::handle::DocHandle,
    execution_id: &str,
) -> Option<CellAnnotationDto> {
    let runtime_state = handle.get_runtime_state().ok()?;
    let annotation = runtime_state.cell_annotations.get(execution_id)?;
    Some(CellAnnotationDto::from(annotation))
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── list_credentials never returns a value field ──────────────────────

    #[test]
    fn credential_info_has_no_value_field() {
        let info = CredentialInfo {
            name: "analytics_api".to_string(),
            keychain_present: true,
            referenced_by_notebook: true,
            description: Some("Test credential".to_string()),
        };
        let json = serde_json::to_value(&info).unwrap();
        assert!(
            json.get("value").is_none(),
            "CredentialInfo must not have a `value` field — got: {json}"
        );
        // name is present
        assert_eq!(json["name"], "analytics_api");
    }

    // ── CellAnnotationDto maps correctly ─────────────────────────────────

    #[test]
    fn cell_annotation_dto_from_runtime_annotation() {
        let annotation = runtime_doc::CellAnnotation {
            kind: "sandbox_http_block".to_string(),
            message: "Domain blocked".to_string(),
            details: Some(serde_json::json!({"domain": "example.com"})),
        };
        let dto = CellAnnotationDto::from(&annotation);
        assert_eq!(dto.kind, "sandbox_http_block");
        assert_eq!(dto.message, "Domain blocked");
        assert!(dto.details.is_some());
    }

    // ── set_notebook_sandbox_profile: invalid profile returns errors ──────

    #[test]
    fn invalid_profile_fails_validation() {
        use notebook_doc::sandbox::{CredentialRef, SandboxProfile};
        let bad_profile = SandboxProfile {
            enabled: true,
            credentials: vec![CredentialRef {
                name: "bad-name".to_string(), // hyphens not allowed
                description: None,
                env_var: None,
                keystore_name: None,
                routes: vec![],
            }],
            allowed_domains: vec![],
        };
        let errors: Vec<String> = bad_profile
            .validate()
            .iter()
            .map(|e| e.to_string())
            .collect();
        assert!(
            !errors.is_empty(),
            "bad profile should produce validation errors"
        );
        assert!(errors.iter().any(|e| e.contains("bad-name")));
    }

    // ── get_sandbox_status: Disabled when no runtime ──────────────────────

    #[cfg(target_os = "macos")]
    #[test]
    fn parse_nono_keychain_names_extracts_accounts() {
        let dump = r#"
keychain: "/Users/user/Library/Keychains/login.keychain-db"
class: "genp"
attributes:
    "acct"<blob>="analytics_api"
    "svce"<blob>="nono"
keychain: "/Users/user/Library/Keychains/login.keychain-db"
class: "genp"
attributes:
    "acct"<blob>="openai"
    "svce"<blob>="nono"
keychain: "/Users/user/Library/Keychains/login.keychain-db"
class: "genp"
attributes:
    "acct"<blob>="some_other"
    "svce"<blob>="other-service"
"#;
        let names = parse_nono_keychain_names(dump);
        assert!(names.contains(&"analytics_api".to_string()));
        assert!(names.contains(&"openai".to_string()));
        assert!(!names.contains(&"some_other".to_string()));
    }
}
