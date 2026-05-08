//! Best-effort redaction for text kernel outputs.
//!
//! The runtime agent builds one redactor per launched kernel from the effective
//! process environment. Output storage calls this before writing text into
//! RuntimeStateDoc or the blob store.

use std::collections::HashSet;
use std::ffi::OsStr;
use std::process::Command;

use notebook_doc::mime::{mime_kind, MimeKind};
use serde_json::Value;

pub(crate) const REDACTION_MARKER: &str = "[redacted env]";
const MIN_VALUE_LEN: usize = 8;

#[derive(Debug, Clone, Default)]
pub(crate) struct OutputRedactor {
    enabled: bool,
    values: Vec<String>,
}

impl OutputRedactor {
    pub(crate) fn disabled() -> Self {
        Self {
            enabled: false,
            values: Vec::new(),
        }
    }

    pub(crate) fn from_current_process_and_command(enabled: bool, cmd: &Command) -> Self {
        if !enabled {
            return Self::disabled();
        }

        let mut values = HashSet::new();
        for (key, value) in std::env::vars_os() {
            add_env_candidate(key.as_os_str(), value.as_os_str(), &mut values);
        }
        for (key, value) in cmd.get_envs() {
            if let Some(value) = value {
                add_env_candidate(key, value, &mut values);
            }
        }

        let mut values: Vec<String> = values.into_iter().collect();
        values.sort_by(|left, right| right.len().cmp(&left.len()).then_with(|| left.cmp(right)));
        Self {
            enabled: true,
            values,
        }
    }

    #[cfg(test)]
    pub(crate) fn from_values_for_test(values: impl IntoIterator<Item = String>) -> Self {
        let mut values: Vec<String> = values
            .into_iter()
            .filter(|value| is_eligible(value))
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        values.sort_by(|left, right| right.len().cmp(&left.len()).then_with(|| left.cmp(right)));
        Self {
            enabled: true,
            values,
        }
    }

    #[cfg(test)]
    pub(crate) fn from_env_pairs_for_test(
        values: impl IntoIterator<Item = (String, String)>,
    ) -> Self {
        let mut candidates = HashSet::new();
        for (key, value) in values {
            add_env_candidate(OsStr::new(&key), OsStr::new(&value), &mut candidates);
        }
        let mut values: Vec<String> = candidates.into_iter().collect();
        values.sort_by(|left, right| right.len().cmp(&left.len()).then_with(|| left.cmp(right)));
        Self {
            enabled: true,
            values,
        }
    }

    pub(crate) fn is_enabled(&self) -> bool {
        self.enabled
    }

    pub(crate) fn redact_text(&self, text: &str) -> String {
        if self.values.is_empty() {
            return text.to_string();
        }

        let mut redacted = text.to_string();
        for value in &self.values {
            if redacted.contains(value) {
                redacted = redacted.replace(value, REDACTION_MARKER);
            }
        }
        redacted
    }

    pub(crate) fn redact_output_value(&self, output: &Value) -> Value {
        if self.values.is_empty() {
            return output.clone();
        }

        let Some(output_type) = output.get("output_type").and_then(|v| v.as_str()) else {
            return output.clone();
        };

        let mut redacted = output.clone();
        match output_type {
            "stream" => {
                redact_object_key(self, &mut redacted, "text");
            }
            "display_data" | "execute_result" => {
                if let Some(data) = redacted.get_mut("data") {
                    redact_data_bundle(self, data);
                }
                if let Some(metadata) = redacted.get_mut("metadata") {
                    redact_json_strings(self, metadata);
                }
            }
            "error" => {
                redact_object_key(self, &mut redacted, "ename");
                redact_object_key(self, &mut redacted, "evalue");
                if let Some(traceback) = redacted.get_mut("traceback") {
                    redact_json_strings(self, traceback);
                }
            }
            _ => {}
        }
        redacted
    }

    pub(crate) fn redact_data_bundle_value(&self, data: &Value) -> Value {
        if self.values.is_empty() {
            return data.clone();
        }
        let mut redacted = data.clone();
        redact_data_bundle(self, &mut redacted);
        redacted
    }

    pub(crate) fn redact_json_value(&self, value: &Value) -> Value {
        if self.values.is_empty() {
            return value.clone();
        }
        let mut redacted = value.clone();
        redact_json_strings(self, &mut redacted);
        redacted
    }
}

fn add_env_candidate(key: &OsStr, value: &OsStr, values: &mut HashSet<String>) {
    let Some(key) = key.to_str() else {
        // Environment keys are normally UTF-8 on supported platforms. If not,
        // skip the candidate rather than guessing at a key-based allowlist.
        return;
    };
    if is_known_non_secret_env_key(key) {
        return;
    }
    add_value_candidate(value, values);
}

fn add_value_candidate(value: &OsStr, values: &mut HashSet<String>) {
    let Some(value) = value.to_str() else {
        // We only redact textual output, so non-UTF-8 env values cannot match
        // the strings this redactor sees.
        return;
    };
    if is_eligible(value) {
        values.insert(value.to_string());
    }
}

fn is_known_non_secret_env_key(key: &str) -> bool {
    let key = key.to_ascii_uppercase();
    matches!(
        key.as_str(),
        "_" | "__CF_USER_TEXT_ENCODING"
            | "CARGO_HOME"
            | "COLORFGBG"
            | "COLORTERM"
            | "CONDA_DEFAULT_ENV"
            | "CONDA_EXE"
            | "CONDA_PREFIX"
            | "CONDA_PYTHON_EXE"
            | "DISPLAY"
            | "GOPATH"
            | "GOROOT"
            | "HOME"
            | "LANG"
            | "LANGUAGE"
            | "LOGNAME"
            | "OLDPWD"
            | "PATH"
            | "PWD"
            | "PYENV_ROOT"
            | "PYTHONHOME"
            | "PYTHONPATH"
            | "RUSTUP_HOME"
            | "SHELL"
            | "SHLVL"
            | "SSH_AUTH_SOCK"
            | "TEMP"
            | "TERM"
            | "TMP"
            | "TMPDIR"
            | "USER"
            | "USERNAME"
            | "VIRTUAL_ENV"
            | "XPC_FLAGS"
            | "XPC_SERVICE_NAME"
    ) || key.starts_with("LC_")
        || key.starts_with("TERM_PROGRAM")
        || key.starts_with("XDG_")
}

fn is_eligible(value: &str) -> bool {
    if value.len() < MIN_VALUE_LEN {
        return false;
    }
    let trimmed = value.trim();
    if trimmed.len() != value.len() || trimmed.is_empty() {
        // Do not redact values with boundary whitespace; those create noisy
        // incidental matches and are unlikely to be emitted exactly in output.
        return false;
    }
    !matches!(
        trimmed.to_ascii_lowercase().as_str(),
        "localhost" | "127.0.0.1" | "0.0.0.0" | "disabled" | "enabled"
    )
}

fn redact_object_key(redactor: &OutputRedactor, value: &mut Value, key: &str) {
    let Some(obj) = value.as_object_mut() else {
        return;
    };
    let Some(slot) = obj.get_mut(key) else {
        return;
    };
    redact_json_strings(redactor, slot);
}

fn redact_data_bundle(redactor: &OutputRedactor, value: &mut Value) {
    let Some(data) = value.as_object_mut() else {
        return;
    };
    for (mime, body) in data {
        if mime_kind(mime) != MimeKind::Binary {
            redact_json_strings(redactor, body);
        }
    }
}

fn redact_json_strings(redactor: &OutputRedactor, value: &mut Value) {
    match value {
        Value::String(text) => {
            *text = redactor.redact_text(text);
        }
        Value::Array(items) => {
            for item in items {
                redact_json_strings(redactor, item);
            }
        }
        Value::Object(map) => {
            for value in map.values_mut() {
                redact_json_strings(redactor, value);
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;

    #[test]
    fn redacts_eligible_values() {
        let redactor = OutputRedactor::from_values_for_test(vec![
            "secret-token-123".to_string(),
            "other-secret".to_string(),
        ]);
        assert_eq!(
            redactor.redact_text("a secret-token-123 and other-secret"),
            "a [redacted env] and [redacted env]"
        );
    }

    #[test]
    fn skips_empty_short_and_common_values() {
        let redactor = OutputRedactor::from_values_for_test(vec![
            "".to_string(),
            "short".to_string(),
            "localhost".to_string(),
            "real-secret".to_string(),
        ]);
        assert_eq!(
            redactor.redact_text("localhost short real-secret"),
            "localhost short [redacted env]"
        );
    }

    #[test]
    fn skips_known_non_secret_env_keys() {
        let redactor = OutputRedactor::from_env_pairs_for_test(vec![
            ("PATH".to_string(), "secret-looking-path-value".to_string()),
            ("HOME".to_string(), "/Users/secret-looking-user".to_string()),
            ("API_TOKEN".to_string(), "secret-token-123".to_string()),
        ]);
        assert_eq!(
            redactor.redact_text(
                "secret-looking-path-value /Users/secret-looking-user secret-token-123"
            ),
            "secret-looking-path-value /Users/secret-looking-user [redacted env]"
        );
    }

    #[test]
    fn tracks_explicit_enabled_state_without_eligible_values() {
        let redactor = OutputRedactor::from_values_for_test(vec!["short".to_string()]);
        assert!(redactor.is_enabled());
        assert_eq!(redactor.redact_text("short"), "short");
    }

    #[test]
    fn prefers_longest_overlapping_values() {
        let redactor = OutputRedactor::from_values_for_test(vec![
            "secret-value".to_string(),
            "secret-value-with-suffix".to_string(),
        ]);
        assert_eq!(
            redactor.redact_text("secret-value-with-suffix secret-value"),
            "[redacted env] [redacted env]"
        );
    }

    #[test]
    fn redacts_textual_output_but_not_binary_mime_payloads() {
        let secret = "secret-value";
        let redactor = OutputRedactor::from_values_for_test(vec![secret.to_string()]);
        let binary = base64::engine::general_purpose::STANDARD.encode(secret);
        let output = serde_json::json!({
            "output_type": "display_data",
            "data": {
                "text/plain": format!("token={secret}"),
                "application/json": { "token": secret },
                "image/png": binary,
            },
            "metadata": { "text/plain": { "title": secret } }
        });

        let redacted = redactor.redact_output_value(&output);
        assert_eq!(redacted["data"]["text/plain"], "token=[redacted env]");
        assert_eq!(
            redacted["data"]["application/json"]["token"],
            "[redacted env]"
        );
        assert_eq!(redacted["data"]["image/png"], output["data"]["image/png"]);
        assert_eq!(
            redacted["metadata"]["text/plain"]["title"],
            "[redacted env]"
        );
    }
}
