/// Credential manager for the macOS Keychain.
///
/// Credentials are stored under service `nono` with the credential name as the
/// account. This matches the lookup convention used by nono at runtime so a
/// credential added here is immediately available to sandboxed kernels.
///
/// An index file (`~/.config/nteract/credentials.json`) stores the name →
/// description mapping so we can enumerate credentials without having to shell
/// out to `security list-generic-passwords`. The index never contains secret
/// values.
///
/// Name validation: `^[a-zA-Z][a-zA-Z0-9_-]*$` — identical to task 03's Rust
/// validator so TypeScript and Rust agree on what names are legal.
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;

/// Metadata for a stored credential — name and optional description.
/// The secret value is never included.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CredentialMeta {
    pub name: String,
    pub description: Option<String>,
}

/// Keychain service name — matches nono's lookup convention.
const KEYCHAIN_SERVICE: &str = "nono";

/// Validate that a credential name matches `^[a-zA-Z][a-zA-Z0-9_-]*$`.
fn validate_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("Credential name must not be empty.".to_string());
    }
    let mut chars = name.chars();
    let first = chars
        .next()
        .ok_or_else(|| "Credential name must not be empty.".to_string())?;
    if !first.is_ascii_alphabetic() {
        return Err(format!(
            "Credential name must start with a letter; got '{}'.",
            first
        ));
    }
    for ch in chars {
        if !ch.is_ascii_alphanumeric() && ch != '_' && ch != '-' {
            return Err(format!(
                "Credential name may only contain letters, digits, underscores, and hyphens; got '{}'.",
                ch
            ));
        }
    }
    Ok(())
}

/// Path to the credential index file (`~/.config/nteract/credentials.json`).
fn index_path() -> Result<PathBuf, String> {
    let config_dir =
        dirs::config_dir().ok_or_else(|| "Could not locate user config directory.".to_string())?;
    Ok(config_dir.join("nteract").join("credentials.json"))
}

/// Read the credential index (name → description).
/// Returns an empty map if the file does not exist yet.
fn read_index() -> Result<BTreeMap<String, Option<String>>, String> {
    let path = index_path()?;
    if !path.exists() {
        return Ok(BTreeMap::new());
    }
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read credential index: {}", e))?;
    serde_json::from_str::<BTreeMap<String, Option<String>>>(&raw)
        .map_err(|e| format!("Failed to parse credential index: {}", e))
}

/// Write the credential index atomically.
fn write_index(index: &BTreeMap<String, Option<String>>) -> Result<(), String> {
    let path = index_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create config directory: {}", e))?;
    }
    let json = serde_json::to_string_pretty(index)
        .map_err(|e| format!("Failed to serialise credential index: {}", e))?;
    // Write to a temp file then rename so a crash doesn't corrupt the index.
    let tmp_path = path.with_extension("json.tmp");
    std::fs::write(&tmp_path, &json)
        .map_err(|e| format!("Failed to write credential index: {}", e))?;
    std::fs::rename(&tmp_path, &path)
        .map_err(|e| format!("Failed to finalise credential index: {}", e))?;
    Ok(())
}

/// List all credentials (names + descriptions). Secret values are never returned.
#[tauri::command]
pub async fn list_credentials() -> Result<Vec<CredentialMeta>, String> {
    let index = read_index()?;
    let metas = index
        .into_iter()
        .map(|(name, description)| CredentialMeta { name, description })
        .collect();
    Ok(metas)
}

/// Add a new credential. Fails if a credential with the same name already exists.
#[tauri::command]
pub async fn add_credential(
    name: String,
    description: Option<String>,
    value: String,
) -> Result<(), String> {
    validate_name(&name)?;

    let mut index = read_index()?;
    if index.contains_key(&name) {
        return Err(format!(
            "A credential named `{}` already exists. Use Edit to update its value.",
            name
        ));
    }

    // Write to keychain first so a failure there doesn't corrupt the index.
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, &name)
        .map_err(|e| format!("Failed to create keychain entry: {}", e))?;
    entry
        .set_password(&value)
        .map_err(|e| keychain_error_message(e))?;

    index.insert(name, description);
    write_index(&index)?;
    Ok(())
}

/// Update the secret value for an existing credential. Name and description are unchanged.
#[tauri::command]
pub async fn update_credential_value(name: String, value: String) -> Result<(), String> {
    validate_name(&name)?;

    let index = read_index()?;
    if !index.contains_key(&name) {
        return Err(format!("No credential named `{}` exists.", name));
    }

    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, &name)
        .map_err(|e| format!("Failed to locate keychain entry: {}", e))?;
    entry
        .set_password(&value)
        .map_err(|e| keychain_error_message(e))?;
    Ok(())
}

/// Delete a credential from both the keychain and the index.
#[tauri::command]
pub async fn delete_credential(name: String) -> Result<(), String> {
    validate_name(&name)?;

    let mut index = read_index()?;
    if !index.contains_key(&name) {
        return Err(format!("No credential named `{}` exists.", name));
    }

    // Best-effort keychain delete — if the item was already removed from the
    // keychain manually, don't block the index cleanup.
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, &name)
        .map_err(|e| format!("Failed to locate keychain entry: {}", e))?;
    if let Err(e) = entry.delete_credential() {
        // `NoEntry` is fine (already deleted); anything else is a real error.
        if !matches!(e, keyring::Error::NoEntry) {
            return Err(keychain_error_message(e));
        }
    }

    index.remove(&name);
    write_index(&index)?;
    Ok(())
}

/// Map keyring errors to human-readable messages that match the UX copy.
fn keychain_error_message(e: keyring::Error) -> String {
    match e {
        keyring::Error::NoEntry => "No such credential in the keychain.".to_string(),
        keyring::Error::Ambiguous(_) => {
            "Multiple keychain entries match this name — please use Keychain Access to resolve the conflict.".to_string()
        }
        _ => {
            format!(
                "macOS denied access to the keychain. Click the keychain prompt or check Keychain Access permissions. ({})",
                e
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_names_pass() {
        for name in &["abc", "API_KEY", "my_token_1", "A1"] {
            assert!(validate_name(name).is_ok(), "expected ok for '{}'", name);
        }
    }

    #[test]
    fn invalid_names_fail() {
        for name in &["", "1abc", "_abc", "my-token", "abc def"] {
            assert!(
                validate_name(name).is_err(),
                "expected error for '{}'",
                name
            );
        }
    }
}
