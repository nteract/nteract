//! Automerge projection for cross-window settings sync.
//!
//! `settings.json` is the durable source of truth. `SettingsDoc` wraps an
//! Automerge `AutoCommit` document as the live projection that the daemon and
//! notebook windows use to exchange settings changes over the sync protocol.
//! Daemon-owned writes mutate and persist canonical JSON first, then refresh
//! this projection; successful client sync writes are mirrored back to JSON.
//!
//! The document uses nested maps for environment-specific settings:
//!
//! ```text
//! ROOT/
//!   theme: "system"
//!   default_runtime: "python"
//!   default_python_env: "uv"
//!   install_default_data_packages: true
//!   disable_nteract_launcher: false
//!   disable_comments: false
//!   uv/                           ← nested Map
//!     default_packages: List[…]   ← List of Str
//!   conda/                        ← nested Map
//!     default_packages: List[…]   ← List of Str
//! ```

use std::path::Path;
#[cfg(debug_assertions)]
use std::sync::atomic::{AtomicUsize, Ordering};

use automerge::sync;
use automerge::sync::SyncDoc;
use automerge::transaction::Transactable;
use automerge::{AutoCommit, AutomergeError, ObjId, ObjType, ReadDoc};
use automerge_recovery::{
    catch_automerge_panic, catch_automerge_result, AutomergeAttempt, AutomergeOperationError,
    AutomergeRecoveryError,
};
use log::info;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
#[cfg(feature = "ts-bindings")]
use ts_rs::TS;

/// UI theme mode for the notebook editor.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default, JsonSchema)]
#[cfg_attr(feature = "ts-bindings", derive(TS))]
#[serde(rename_all = "lowercase")]
#[cfg_attr(feature = "ts-bindings", ts(export))]
pub enum ThemeMode {
    /// Follow the OS preference and update automatically
    #[default]
    System,
    /// Force light mode
    Light,
    /// Force dark mode
    Dark,
}

impl std::fmt::Display for ThemeMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ThemeMode::System => write!(f, "system"),
            ThemeMode::Light => write!(f, "light"),
            ThemeMode::Dark => write!(f, "dark"),
        }
    }
}

/// Color theme for the notebook editor.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default, JsonSchema)]
#[cfg_attr(feature = "ts-bindings", derive(TS))]
#[serde(rename_all = "lowercase")]
#[cfg_attr(feature = "ts-bindings", ts(export))]
pub enum ColorTheme {
    /// Neutral palette matching the notebook design system
    #[default]
    Classic,
    /// Warm, document-like palette with brown accents
    Cream,
}

use crate::runtime::Runtime;

/// Python environment type for dependency management.
///
/// Unknown values are captured in the `Other` variant so they survive
/// serialization round-trips across branches that add new env types.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
#[cfg_attr(feature = "ts-bindings", derive(TS))]
#[cfg_attr(feature = "ts-bindings", ts(export))]
#[cfg_attr(
    feature = "ts-bindings",
    ts(type = "\"uv\" | \"conda\" | \"pixi\" | (string & {})")
)]
pub enum PythonEnvType {
    /// Use uv for Python package management (fast, pip-compatible)
    #[default]
    Uv,
    /// Use conda for Python package management (supports conda packages)
    Conda,
    /// Use pixi for Python package management (conda + pip unified)
    Pixi,
    /// An unrecognized env type value, preserved for round-tripping.
    Other(String),
}

impl serde::Serialize for PythonEnvType {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

impl<'de> serde::Deserialize<'de> for PythonEnvType {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let s = String::deserialize(deserializer)?;
        Ok(s.parse().expect("FromStr for PythonEnvType is infallible"))
    }
}

impl JsonSchema for PythonEnvType {
    fn schema_name() -> std::borrow::Cow<'static, str> {
        "PythonEnvType".into()
    }

    fn json_schema(_gen: &mut schemars::SchemaGenerator) -> schemars::Schema {
        schemars::json_schema!({
            "type": "string",
            "examples": ["uv", "conda", "pixi"]
        })
    }
}

impl std::fmt::Display for PythonEnvType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PythonEnvType::Uv => write!(f, "uv"),
            PythonEnvType::Conda => write!(f, "conda"),
            PythonEnvType::Pixi => write!(f, "pixi"),
            PythonEnvType::Other(s) => write!(f, "{}", s),
        }
    }
}

impl std::str::FromStr for PythonEnvType {
    type Err = std::convert::Infallible;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Ok(match s.to_lowercase().as_str() {
            "uv" => PythonEnvType::Uv,
            "conda" => PythonEnvType::Conda,
            "pixi" => PythonEnvType::Pixi,
            _ => PythonEnvType::Other(s.to_string()),
        })
    }
}

/// Default packages for uv environments.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[cfg_attr(feature = "ts-bindings", derive(TS))]
#[cfg_attr(feature = "ts-bindings", ts(export))]
pub struct UvDefaults {
    pub default_packages: Vec<String>,
}

/// Default packages for conda environments.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[cfg_attr(feature = "ts-bindings", derive(TS))]
#[cfg_attr(feature = "ts-bindings", ts(export))]
pub struct CondaDefaults {
    pub default_packages: Vec<String>,
}

/// Default packages for pixi environments.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[cfg_attr(feature = "ts-bindings", derive(TS))]
#[cfg_attr(feature = "ts-bindings", ts(export))]
pub struct PixiDefaults {
    pub default_packages: Vec<String>,
}

/// Default keep-alive duration in seconds for notebook rooms.
/// When all clients disconnect, the daemon waits this long before evicting the room.
pub const DEFAULT_KEEP_ALIVE_SECS: u64 = 30;

/// Minimum keep-alive duration (5 seconds) to prevent accidental instant eviction.
pub const MIN_KEEP_ALIVE_SECS: u64 = 5;

/// Maximum keep-alive duration (7 days) for notebook rooms.
pub const MAX_KEEP_ALIVE_SECS: u64 = 604800;

pub const DEFAULT_POOL_SIZE: u64 = 1;
pub const DEFAULT_SELECTED_POOL_SIZE: u64 = 2;
pub const DEFAULT_UV_POOL_SIZE: u64 = DEFAULT_POOL_SIZE;
pub const DEFAULT_CONDA_POOL_SIZE: u64 = DEFAULT_POOL_SIZE;
pub const DEFAULT_PIXI_POOL_SIZE: u64 = DEFAULT_POOL_SIZE;
pub const MAX_POOL_SIZE: u64 = 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PoolSizeDefaults {
    pub uv_pool_size: u64,
    pub conda_pool_size: u64,
    pub pixi_pool_size: u64,
}

pub fn default_pool_sizes_for_python_env(env: &PythonEnvType) -> PoolSizeDefaults {
    match env {
        PythonEnvType::Uv => PoolSizeDefaults {
            uv_pool_size: DEFAULT_SELECTED_POOL_SIZE,
            conda_pool_size: DEFAULT_POOL_SIZE,
            pixi_pool_size: DEFAULT_POOL_SIZE,
        },
        PythonEnvType::Conda => PoolSizeDefaults {
            uv_pool_size: DEFAULT_POOL_SIZE,
            conda_pool_size: DEFAULT_SELECTED_POOL_SIZE,
            pixi_pool_size: DEFAULT_POOL_SIZE,
        },
        PythonEnvType::Pixi => PoolSizeDefaults {
            uv_pool_size: DEFAULT_POOL_SIZE,
            conda_pool_size: DEFAULT_POOL_SIZE,
            pixi_pool_size: DEFAULT_SELECTED_POOL_SIZE,
        },
        PythonEnvType::Other(_) => PoolSizeDefaults {
            uv_pool_size: DEFAULT_POOL_SIZE,
            conda_pool_size: DEFAULT_POOL_SIZE,
            pixi_pool_size: DEFAULT_POOL_SIZE,
        },
    }
}

/// Snapshot of all synced settings.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[cfg_attr(feature = "ts-bindings", derive(TS))]
#[cfg_attr(feature = "ts-bindings", ts(export))]
pub struct SyncedSettings {
    /// UI theme mode (light/dark/system)
    #[serde(default)]
    pub theme: ThemeMode,

    /// Color theme (classic/cream)
    #[serde(default)]
    pub color_theme: ColorTheme,

    /// Default runtime for new notebooks
    #[serde(default)]
    pub default_runtime: Runtime,

    /// Default Python environment type (uv or conda)
    #[serde(default)]
    pub default_python_env: PythonEnvType,

    /// UV environment defaults
    #[serde(default)]
    pub uv: UvDefaults,

    /// Conda environment defaults
    #[serde(default)]
    pub conda: CondaDefaults,

    /// Pixi environment defaults
    #[serde(default)]
    pub pixi: PixiDefaults,

    /// How long (in seconds) to keep notebook rooms alive after all clients disconnect.
    /// This allows you to close and reopen the window without losing your kernel state.
    /// Range: 5 seconds to 7 days (604800 seconds).
    #[serde(default = "default_keep_alive_secs")]
    pub keep_alive_secs: u64,

    /// Whether the user has completed the first-launch onboarding flow.
    /// When false, the app shows the onboarding screen on startup.
    #[serde(default)]
    pub onboarding_completed: bool,

    /// Number of prewarmed UV environments to keep ready. 0 disables the pool.
    #[serde(default = "default_uv_pool_size")]
    pub uv_pool_size: u64,

    /// Number of prewarmed Conda environments to keep ready. 0 disables the pool.
    #[serde(default = "default_conda_pool_size")]
    pub conda_pool_size: u64,

    /// Number of prewarmed Pixi environments to keep ready. 0 disables the pool.
    #[serde(default = "default_pixi_pool_size")]
    pub pixi_pool_size: u64,

    /// Install the curated data-science package set in prewarmed pool environments.
    ///
    /// When true, UV/Conda/Pixi pools include pandas, polars, matplotlib,
    /// plotly, and altair in addition to the managed notebook runtime. Project
    /// notebooks with explicit dependencies are unaffected.
    #[serde(default = "default_install_default_data_packages")]
    pub install_default_data_packages: bool,

    /// Disable the nteract kernel launcher and fall back to the legacy
    /// `ipykernel_launcher` entry point.
    ///
    /// The nteract launcher is now the default path so Python kernels can
    /// register rich DataFrame and exception formatters before the first user
    /// cell. This opt-out flag is an escape hatch for environments that need
    /// vanilla IPython launch behavior.
    #[serde(default)]
    pub disable_nteract_launcher: bool,

    /// Disable comments UI surfaces while keeping comments sync active.
    #[serde(default)]
    pub disable_comments: bool,

    /// Redact eligible environment variable values from text outputs for newly
    /// launched or restarted kernels.
    ///
    /// The runtime agent applies this before output manifests or blobs are
    /// written, so the setting is global-only and intentionally not stored in
    /// notebook metadata.
    #[serde(default = "default_redact_env_values_in_outputs")]
    pub redact_env_values_in_outputs: bool,

    /// Merge the daemon's captured shell startup env into each kernel launch's
    /// `env_vars`. Combined with `redact_env_values_in_outputs`, the user's
    /// shell secrets reach the kernel but stay out of outputs and the blob
    /// store. Default `true` to match Jupyter's behavior, but redacted on the
    /// way out.
    #[serde(default = "default_import_shell_environment")]
    pub import_shell_environment: bool,

    // ── Telemetry ───────────────────────────────────────────────────
    /// Opaque per-install UUIDv4. Generated on first heartbeat, persisted in
    /// settings. Not derived from any identifying data.
    #[serde(default)]
    pub install_id: String,

    /// Master telemetry switch. When false, no heartbeat pings are sent.
    #[serde(default = "default_telemetry_enabled")]
    pub telemetry_enabled: bool,

    /// Whether the user has explicitly recorded a telemetry decision (pressed
    /// either the "You can count on me!" or "Opt out of metrics, continue"
    /// button during onboarding). Default false. Until this is true, no
    /// heartbeat fires, even when `telemetry_enabled = true`. Satisfies the
    /// GDPR "clear affirmative action" requirement.
    #[serde(default)]
    pub telemetry_consent_recorded: bool,

    /// Unix-seconds timestamp of the last successful daemon heartbeat.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub telemetry_last_daemon_ping_at: Option<u64>,

    /// Unix-seconds timestamp of the last successful app heartbeat.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub telemetry_last_app_ping_at: Option<u64>,

    /// Unix-seconds timestamp of the last successful MCP heartbeat.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub telemetry_last_mcp_ping_at: Option<u64>,
}

impl SyncedSettings {
    /// Snapshot the user's feature-flag settings.
    pub fn feature_flags(&self) -> notebook_protocol::protocol::FeatureFlags {
        notebook_protocol::protocol::FeatureFlags {
            bootstrap_dx: !self.disable_nteract_launcher,
        }
    }
}

impl Default for SyncedSettings {
    fn default() -> Self {
        let pool_sizes = default_pool_sizes_for_python_env(&PythonEnvType::default());
        Self {
            theme: ThemeMode::default(),
            color_theme: ColorTheme::default(),
            default_runtime: Runtime::default(),
            default_python_env: PythonEnvType::default(),
            uv: UvDefaults::default(),
            conda: CondaDefaults::default(),
            pixi: PixiDefaults::default(),
            keep_alive_secs: DEFAULT_KEEP_ALIVE_SECS,
            onboarding_completed: false,
            uv_pool_size: pool_sizes.uv_pool_size,
            conda_pool_size: pool_sizes.conda_pool_size,
            pixi_pool_size: pool_sizes.pixi_pool_size,
            install_default_data_packages: true,
            disable_nteract_launcher: false,
            disable_comments: false,
            redact_env_values_in_outputs: true,
            import_shell_environment: true,
            install_id: String::new(),
            telemetry_enabled: true,
            telemetry_consent_recorded: false,
            telemetry_last_daemon_ping_at: None,
            telemetry_last_app_ping_at: None,
            telemetry_last_mcp_ping_at: None,
        }
    }
}

fn default_telemetry_enabled() -> bool {
    true
}

fn default_redact_env_values_in_outputs() -> bool {
    true
}

fn default_import_shell_environment() -> bool {
    true
}

fn default_keep_alive_secs() -> u64 {
    DEFAULT_KEEP_ALIVE_SECS
}
fn default_uv_pool_size() -> u64 {
    DEFAULT_UV_POOL_SIZE
}
fn default_conda_pool_size() -> u64 {
    DEFAULT_CONDA_POOL_SIZE
}
fn default_pixi_pool_size() -> u64 {
    DEFAULT_PIXI_POOL_SIZE
}
fn default_install_default_data_packages() -> bool {
    true
}

/// Backfill `telemetry_consent_recorded` for installations that completed
/// onboarding before the consent flag existed. Without this, all existing
/// users would look like they had never consented, and their heartbeats
/// would stop at the next app launch.
///
/// Called once on daemon startup. Idempotent. Returns `true` when the
/// settings snapshot changed.
pub fn backfill_telemetry_consent(settings: &mut SyncedSettings) -> bool {
    if !settings.telemetry_consent_recorded && settings.onboarding_completed {
        settings.telemetry_consent_recorded = true;
        return true;
    }
    false
}

/// Ensure an install ID exists in a materialized settings snapshot.
///
/// Returns the install ID and whether it had to be generated.
pub fn ensure_install_id_in_settings(settings: &mut SyncedSettings) -> (String, bool) {
    if !settings.install_id.is_empty() {
        return (settings.install_id.clone(), false);
    }

    let id = uuid::Uuid::new_v4().to_string();
    settings.install_id = id.clone();
    (id, true)
}

/// Ensure an `install_id` exists in the settings doc, generating one if needed.
/// Returns the (possibly freshly-generated) install ID.
pub fn ensure_install_id(settings: &mut SettingsDoc) -> String {
    if let Some(existing) = settings.get("install_id") {
        if !existing.is_empty() {
            return existing;
        }
    }
    let id = uuid::Uuid::new_v4().to_string();
    settings.put("install_id", &id);
    id
}

/// Doc-level variant of [`backfill_telemetry_consent`] for callers that hold
/// a `SettingsDoc` (e.g. the daemon at startup) rather than a fully
/// materialized `SyncedSettings`. Returns `true` if the flag was flipped so
/// the caller can choose to persist immediately.
///
/// Idempotent: safe to call on every startup.
pub fn backfill_telemetry_consent_in_doc(settings: &mut SettingsDoc) -> bool {
    let already_recorded = settings
        .get_bool("telemetry_consent_recorded")
        .unwrap_or(false);
    if already_recorded {
        return false;
    }
    let onboarded = settings.get_bool("onboarding_completed").unwrap_or(false);
    if !onboarded {
        return false;
    }
    settings.put_bool("telemetry_consent_recorded", true);
    true
}

/// Generate a JSON Schema string for the settings file.
pub fn generate_settings_schema() -> Result<String, serde_json::Error> {
    let schema = schemars::schema_for!(SyncedSettings);
    serde_json::to_string_pretty(&schema)
}

/// Write the settings schema file to disk.
pub fn write_settings_schema() -> std::io::Result<()> {
    let path = crate::settings_schema_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let schema = generate_settings_schema().map_err(std::io::Error::other)?;
    std::fs::write(&path, format!("{schema}\n"))
}

/// Read canonical settings JSON into a materialized settings snapshot.
///
/// This intentionally routes through `SettingsDoc::from_json_value` so legacy
/// values and field-level type mismatches keep the same tolerant migration
/// behavior as daemon startup.
pub fn read_synced_settings_json(path: &Path) -> std::io::Result<SyncedSettings> {
    let contents = std::fs::read_to_string(path)?;
    let json =
        serde_json::from_str::<serde_json::Value>(&contents).map_err(std::io::Error::other)?;
    Ok(SettingsDoc::from_json_value(&json).get_all())
}

/// Write a materialized settings snapshot to canonical settings JSON.
pub fn write_synced_settings_json(path: &Path, settings: &SyncedSettings) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let mut json_value = serde_json::to_value(settings).map_err(std::io::Error::other)?;
    if let Some(obj) = json_value.as_object_mut() {
        obj.insert(
            "$schema".to_string(),
            serde_json::Value::String("./settings.schema.json".to_string()),
        );
    }
    let json = serde_json::to_string_pretty(&json_value).map_err(std::io::Error::other)?;
    std::fs::write(path, format!("{json}\n"))
}

/// Wrapper around an Automerge document storing application settings.
///
/// The document uses a mix of root-level scalar strings and nested maps
/// containing lists for environment-specific settings.
pub struct SettingsDoc {
    doc: AutoCommit,
}

#[cfg(debug_assertions)]
static PANIC_ON_NEXT_GENERATE_SYNC_CALLS: AtomicUsize = AtomicUsize::new(0);
#[cfg(debug_assertions)]
static PANIC_ON_NEXT_RECEIVE_SYNC_CALLS: AtomicUsize = AtomicUsize::new(0);
#[cfg(debug_assertions)]
static PATCH_LOG_MISMATCH_ON_NEXT_RECEIVE_SYNC_CALLS: AtomicUsize = AtomicUsize::new(0);

impl SettingsDoc {
    /// Create a new empty settings document with defaults.
    pub fn new() -> Self {
        let mut doc = AutoCommit::new();
        let defaults = SyncedSettings::default();

        // Root-level scalars (Automerge stores strings; enums are serialized via Display)
        let _ = doc.put(automerge::ROOT, "theme", defaults.theme.to_string());
        let _ = doc.put(
            automerge::ROOT,
            "color_theme",
            match defaults.color_theme {
                ColorTheme::Classic => "classic",
                ColorTheme::Cream => "cream",
            },
        );
        let _ = doc.put(
            automerge::ROOT,
            "default_runtime",
            defaults.default_runtime.to_string(),
        );
        let _ = doc.put(
            automerge::ROOT,
            "default_python_env",
            defaults.default_python_env.to_string(),
        );
        // Store keep_alive_secs as i64 (Automerge's numeric type)
        let _ = doc.put(
            automerge::ROOT,
            "keep_alive_secs",
            defaults.keep_alive_secs as i64,
        );
        // Store onboarding_completed as boolean
        let _ = doc.put(automerge::ROOT, "onboarding_completed", false);

        // nteract kernel launcher is default-on; this is the legacy escape hatch.
        let _ = doc.put(
            automerge::ROOT,
            "disable_nteract_launcher",
            defaults.disable_nteract_launcher,
        );
        let _ = doc.put(
            automerge::ROOT,
            "disable_comments",
            defaults.disable_comments,
        );
        let _ = doc.put(
            automerge::ROOT,
            "redact_env_values_in_outputs",
            defaults.redact_env_values_in_outputs,
        );
        let _ = doc.put(
            automerge::ROOT,
            "import_shell_environment",
            defaults.import_shell_environment,
        );
        let _ = doc.put(
            automerge::ROOT,
            "install_default_data_packages",
            defaults.install_default_data_packages,
        );

        // Telemetry defaults (install_id left empty until first heartbeat)
        let _ = doc.put(automerge::ROOT, "install_id", "");
        let _ = doc.put(automerge::ROOT, "telemetry_enabled", true);
        let _ = doc.put(automerge::ROOT, "telemetry_consent_recorded", false);

        // Nested uv map with empty package list
        if let Ok(uv_id) = doc.put_object(automerge::ROOT, "uv", ObjType::Map) {
            let _ = doc.put_object(&uv_id, "default_packages", ObjType::List);
        }

        // Nested conda map with empty package list
        if let Ok(conda_id) = doc.put_object(automerge::ROOT, "conda", ObjType::Map) {
            let _ = doc.put_object(&conda_id, "default_packages", ObjType::List);
        }

        // Nested pixi map with empty package list
        if let Ok(pixi_id) = doc.put_object(automerge::ROOT, "pixi", ObjType::Map) {
            let _ = doc.put_object(&pixi_id, "default_packages", ObjType::List);
        }

        Self { doc }
    }

    /// Load the canonical JSON settings, migrate a legacy Automerge settings
    /// document once when JSON is missing, or create a new document with
    /// defaults.
    ///
    /// The returned `SettingsDoc` is still the in-memory sync document used by
    /// the live settings protocol. On disk, `settings.json` is the source of
    /// truth; `settings.automerge` is read only as a migration source when the
    /// JSON file does not exist.
    pub fn load_or_create(automerge_path: &Path, settings_json_path: Option<&Path>) -> Self {
        if let Some(json_path) = settings_json_path {
            if json_path.exists() {
                match std::fs::read_to_string(json_path)
                    .ok()
                    .and_then(|contents| serde_json::from_str::<serde_json::Value>(&contents).ok())
                {
                    Some(json) => {
                        info!("[settings] Loaded canonical settings from {:?}", json_path);
                        return Self::from_json_value(&json);
                    }
                    None => {
                        log::warn!(
                            "[settings] Failed to load canonical settings.json from {:?}; trying legacy Automerge settings before defaults",
                            json_path
                        );
                    }
                }
            }
        }

        // One-time migration from the legacy Automerge settings document.
        if automerge_path.exists() {
            if let Ok(data) = std::fs::read(automerge_path) {
                if let Ok(doc) = AutoCommit::load(&data) {
                    info!(
                        "[settings] Migrating legacy Automerge settings from {:?}",
                        automerge_path
                    );
                    let mut settings = Self { doc };
                    settings.migrate_flat_to_nested();
                    settings.migrate_null_keep_alive();

                    if let Some(json_path) = settings_json_path {
                        if let Err(e) = settings.save_json_mirror(json_path) {
                            log::warn!("[settings] Failed to write migrated settings.json: {e}");
                        }
                    }

                    return settings;
                }
            }
        }

        info!("[settings] Creating new settings doc with defaults");
        let settings = Self::new();
        if let Some(json_path) = settings_json_path {
            if let Err(e) = settings.save_json_mirror(json_path) {
                log::warn!("[settings] Failed to write default settings.json: {e}");
            }
        }
        settings
    }

    /// Create a settings document from parsed canonical settings JSON.
    pub fn from_json_value(json: &serde_json::Value) -> Self {
        let mut settings = Self::new();

        if let Some(theme) = json.get("theme").and_then(|v| v.as_str()) {
            settings.put("theme", theme);
        }
        if let Some(color_theme) = json.get("color_theme").and_then(|v| v.as_str()) {
            settings.put("color_theme", color_theme);
        }
        if let Some(runtime) = json.get("default_runtime").and_then(|v| v.as_str()) {
            settings.put("default_runtime", runtime);
        }
        if let Some(env) = json.get("default_python_env").and_then(|v| v.as_str()) {
            settings.put("default_python_env", env);
        }
        // keep_alive_secs: numeric value in seconds (5 to 604800)
        // Legacy null means "forever", which we migrate to MAX_KEEP_ALIVE_SECS
        if let Some(val) = json.get("keep_alive_secs") {
            if val.is_null() {
                // Migration: null (legacy "forever" mode) -> MAX_KEEP_ALIVE_SECS
                settings.put_u64("keep_alive_secs", MAX_KEEP_ALIVE_SECS);
            } else if let Some(secs) = val.as_u64() {
                settings.put_u64("keep_alive_secs", secs);
            }
        }
        // onboarding_completed: boolean
        if let Some(completed) = json.get("onboarding_completed").and_then(|v| v.as_bool()) {
            settings.put_bool("onboarding_completed", completed);
        }

        // disable_nteract_launcher: boolean
        if let Some(disabled) = json
            .get("disable_nteract_launcher")
            .and_then(|v| v.as_bool())
        {
            settings.put_bool("disable_nteract_launcher", disabled);
        }
        // disable_comments: boolean
        if let Some(disabled) = json.get("disable_comments").and_then(|v| v.as_bool()) {
            settings.put_bool("disable_comments", disabled);
        }
        if let Some(enabled) = json
            .get("redact_env_values_in_outputs")
            .and_then(|v| v.as_bool())
        {
            settings.put_bool("redact_env_values_in_outputs", enabled);
        }
        if let Some(enabled) = json
            .get("import_shell_environment")
            .and_then(|v| v.as_bool())
        {
            settings.put_bool("import_shell_environment", enabled);
        }
        if let Some(enabled) = json
            .get("install_default_data_packages")
            .and_then(|v| v.as_bool())
        {
            settings.put_bool("install_default_data_packages", enabled);
        }

        // Telemetry fields
        if let Some(id) = json.get("install_id").and_then(|v| v.as_str()) {
            if !id.is_empty() {
                settings.put("install_id", id);
            }
        }
        if let Some(enabled) = json.get("telemetry_enabled").and_then(|v| v.as_bool()) {
            settings.put_bool("telemetry_enabled", enabled);
        }
        if let Some(recorded) = json
            .get("telemetry_consent_recorded")
            .and_then(|v| v.as_bool())
        {
            settings.put_bool("telemetry_consent_recorded", recorded);
        }
        if let Some(ts) = json
            .get("telemetry_last_daemon_ping_at")
            .and_then(|v| v.as_u64())
        {
            settings.put_u64("telemetry_last_daemon_ping_at", ts);
        }
        if let Some(ts) = json
            .get("telemetry_last_app_ping_at")
            .and_then(|v| v.as_u64())
        {
            settings.put_u64("telemetry_last_app_ping_at", ts);
        }
        if let Some(ts) = json
            .get("telemetry_last_mcp_ping_at")
            .and_then(|v| v.as_u64())
        {
            settings.put_u64("telemetry_last_mcp_ping_at", ts);
        }

        // Pool sizes (numeric values, import from JSON if present)
        if let Some(uv_size) = json.get("uv_pool_size").and_then(|v| v.as_u64()) {
            settings.put_u64("uv_pool_size", uv_size);
        }
        if let Some(conda_size) = json.get("conda_pool_size").and_then(|v| v.as_u64()) {
            settings.put_u64("conda_pool_size", conda_size);
        }
        if let Some(pixi_size) = json.get("pixi_pool_size").and_then(|v| v.as_u64()) {
            settings.put_u64("pixi_pool_size", pixi_size);
        }

        let uv_packages = Self::extract_packages_from_json(json, "uv");
        if !uv_packages.is_empty() {
            settings.put_list("uv.default_packages", &uv_packages);
        }

        let conda_packages = Self::extract_packages_from_json(json, "conda");
        if !conda_packages.is_empty() {
            settings.put_list("conda.default_packages", &conda_packages);
        }

        let pixi_packages = Self::extract_packages_from_json(json, "pixi");
        if !pixi_packages.is_empty() {
            settings.put_list("pixi.default_packages", &pixi_packages);
        }

        settings
    }

    /// Create a settings document from a materialized settings snapshot.
    pub fn from_synced_settings(settings: &SyncedSettings) -> Self {
        let json = match serde_json::to_value(settings) {
            Ok(json) => json,
            Err(error) => unreachable!("SyncedSettings serializes: {error}"),
        };
        Self::from_json_value(&json)
    }

    /// Extract packages from a nested JSON key (e.g. `uv.default_packages`).
    fn extract_packages_from_json(json: &serde_json::Value, nested_key: &str) -> Vec<String> {
        if let Some(nested) = json.get(nested_key).and_then(|v| v.as_object()) {
            if let Some(arr) = nested.get("default_packages").and_then(|v| v.as_array()) {
                return arr
                    .iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect();
            }
        }
        vec![]
    }

    /// Migrate old flat keys to nested structure.
    ///
    /// Reads `default_uv_packages` and `default_conda_packages` from ROOT,
    /// splits comma values, stores them as nested lists, and deletes the old keys.
    fn migrate_flat_to_nested(&mut self) {
        // Migrate default_uv_packages -> uv.default_packages
        if let Some(val) = self.get_flat("default_uv_packages") {
            let packages = split_comma_list(&val);
            if !packages.is_empty() {
                self.put_list("uv.default_packages", &packages);
            }
            let _ = self.doc.delete(automerge::ROOT, "default_uv_packages");
            info!("[settings] Migrated default_uv_packages to uv.default_packages");
        }

        // Migrate default_conda_packages -> conda.default_packages
        if let Some(val) = self.get_flat("default_conda_packages") {
            let packages = split_comma_list(&val);
            if !packages.is_empty() {
                self.put_list("conda.default_packages", &packages);
            }
            let _ = self.doc.delete(automerge::ROOT, "default_conda_packages");
            info!("[settings] Migrated default_conda_packages to conda.default_packages");
        }
    }

    /// Migrate legacy null keep_alive_secs (from "forever" mode) to MAX_KEEP_ALIVE_SECS.
    ///
    /// Previously, `null` meant "keep alive forever". Now we use a fixed maximum of 7 days.
    /// This migration ensures users who had "forever" mode get the longest available duration
    /// instead of silently falling back to the 30-second default.
    fn migrate_null_keep_alive(&mut self) {
        if self.is_null("keep_alive_secs") {
            info!(
                "[settings] Migrating null keep_alive_secs to MAX_KEEP_ALIVE_SECS ({})",
                MAX_KEEP_ALIVE_SECS
            );
            self.put_u64("keep_alive_secs", MAX_KEEP_ALIVE_SECS);
        }
    }

    /// Load a settings document from raw bytes.
    pub fn load(data: &[u8]) -> Result<Self, AutomergeError> {
        let doc = AutoCommit::load(data)?;
        Ok(Self { doc })
    }

    /// Serialize the document to bytes for persistence.
    pub fn save(&mut self) -> Vec<u8> {
        self.doc.save()
    }

    /// Save the document to a file.
    pub fn save_to_file(&mut self, path: &Path) -> std::io::Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let data = self.save();
        std::fs::write(path, data)
    }

    /// Write the canonical human-readable JSON settings file.
    ///
    /// Injects a `$schema` key pointing to the companion schema file so editors
    /// can provide autocomplete and validation.
    pub fn save_json_mirror(&self, path: &Path) -> std::io::Result<()> {
        let settings = self.get_all();
        write_synced_settings_json(path, &settings)
    }

    // ── Scalar accessors ─────────────────────────────────────────────

    /// Read a scalar string from ROOT only (no dotted path support).
    fn get_flat(&self, key: &str) -> Option<String> {
        read_scalar_str(&self.doc, automerge::ROOT, key)
    }

    /// Get a scalar setting value, supporting dotted paths for nested maps.
    ///
    /// E.g. `"theme"` reads from ROOT, `"uv.some_key"` reads from the `uv` sub-map.
    pub fn get(&self, key: &str) -> Option<String> {
        if let Some((map_key, sub_key)) = key.split_once('.') {
            let map_id = self.get_map_id(map_key)?;
            read_scalar_str(&self.doc, map_id, sub_key)
        } else {
            self.get_flat(key)
        }
    }

    /// Get a boolean setting value from the root.
    pub fn get_bool(&self, key: &str) -> Option<bool> {
        self.doc
            .get(automerge::ROOT, key)
            .ok()
            .flatten()
            .and_then(|(value, _)| match value {
                automerge::Value::Scalar(s) => match s.as_ref() {
                    automerge::ScalarValue::Boolean(b) => Some(*b),
                    // Also support string "true"/"false" for migration
                    automerge::ScalarValue::Str(s) => match s.as_str() {
                        "true" => Some(true),
                        "false" => Some(false),
                        _ => None,
                    },
                    _ => None,
                },
                _ => None,
            })
    }

    /// Set a boolean setting value at the root.
    pub fn put_bool(&mut self, key: &str, value: bool) {
        let _ = self.doc.put(automerge::ROOT, key, value);
    }

    /// Get a u64 setting value from the root.
    pub fn get_u64(&self, key: &str) -> Option<u64> {
        self.doc
            .get(automerge::ROOT, key)
            .ok()
            .flatten()
            .and_then(|(value, _)| match value {
                automerge::Value::Scalar(s) => match s.as_ref() {
                    // Use try_from to prevent negative values wrapping to huge u64
                    automerge::ScalarValue::Int(i) => u64::try_from(*i).ok(),
                    automerge::ScalarValue::Uint(u) => Some(*u),
                    // Also support string for migration/JSON compatibility
                    automerge::ScalarValue::Str(s) => s.parse().ok(),
                    _ => None,
                },
                _ => None,
            })
    }

    /// Set a u64 setting value at the root.
    ///
    /// Values are clamped to i64::MAX to prevent overflow during conversion.
    pub fn put_u64(&mut self, key: &str, value: u64) {
        // Clamp to i64::MAX to prevent overflow (Automerge stores as signed int)
        let clamped = value.min(i64::MAX as u64);
        let _ = self.doc.put(automerge::ROOT, key, clamped as i64);
    }

    /// Check if a key exists in the document but has a null value.
    fn is_null(&self, key: &str) -> bool {
        self.doc
            .get(automerge::ROOT, key)
            .ok()
            .flatten()
            .map(|(value, _)| matches!(value, automerge::Value::Scalar(s) if matches!(s.as_ref(), automerge::ScalarValue::Null)))
            .unwrap_or(false)
    }

    /// Set a scalar setting value, supporting dotted paths for nested maps.
    pub fn put(&mut self, key: &str, value: &str) {
        if let Some((map_key, sub_key)) = key.split_once('.') {
            let map_id = self.ensure_map(map_key);
            let _ = self.doc.put(&map_id, sub_key, value);
        } else {
            let _ = self.doc.put(automerge::ROOT, key, value);
        }
    }

    // ── List accessors ───────────────────────────────────────────────

    /// Read a list of strings at a dotted path (e.g. `"uv.default_packages"`).
    pub fn get_list(&self, key: &str) -> Vec<String> {
        let (map_key, sub_key) = match key.split_once('.') {
            Some(pair) => pair,
            None => return vec![],
        };
        let map_id = match self.get_map_id(map_key) {
            Some(id) => id,
            None => return vec![],
        };
        let list_id = match self.doc.get(&map_id, sub_key).ok().flatten() {
            Some((automerge::Value::Object(ObjType::List), id)) => id,
            _ => return vec![],
        };
        let len = self.doc.length(&list_id);
        (0..len)
            .filter_map(|i| {
                self.doc
                    .get(&list_id, i)
                    .ok()
                    .flatten()
                    .and_then(|(value, _)| match value {
                        automerge::Value::Scalar(s) => match s.as_ref() {
                            automerge::ScalarValue::Str(s) => Some(s.to_string()),
                            _ => None,
                        },
                        _ => None,
                    })
            })
            .collect()
    }

    /// Replace a list of strings at a dotted path.
    ///
    /// Deletes the existing list (if any) and creates a new one with the given items.
    pub fn put_list(&mut self, key: &str, values: &[String]) {
        let (map_key, sub_key) = match key.split_once('.') {
            Some(pair) => pair,
            None => return,
        };
        let map_id = self.ensure_map(map_key);

        // Delete existing value at this key (list or otherwise)
        let _ = self.doc.delete(&map_id, sub_key);

        // Create new list and insert items
        if let Ok(list_id) = self.doc.put_object(&map_id, sub_key, ObjType::List) {
            for (i, item) in values.iter().enumerate() {
                let _ = self.doc.insert(&list_id, i, item.as_str());
            }
        }
    }

    /// Set a value from a `serde_json::Value` — dispatches to `put` for strings,
    /// `put_list` for arrays, `put_bool` for booleans, or `put_u64` for numbers.
    /// Used by Tauri commands.
    pub fn put_value(&mut self, key: &str, value: &serde_json::Value) {
        match value {
            serde_json::Value::String(s) => self.put(key, s),
            serde_json::Value::Array(arr) => {
                let items: Vec<String> = arr
                    .iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect();
                self.put_list(key, &items);
            }
            serde_json::Value::Bool(b) => self.put_bool(key, *b),
            serde_json::Value::Number(n) => {
                if let Some(u) = n.as_u64() {
                    self.put_u64(key, u);
                }
            }
            _ => {}
        }
    }

    // ── Helpers ──────────────────────────────────────────────────────

    /// Look up a nested Map object at ROOT.
    fn get_map_id(&self, map_key: &str) -> Option<ObjId> {
        self.doc
            .get(automerge::ROOT, map_key)
            .ok()
            .flatten()
            .and_then(|(value, id)| match value {
                automerge::Value::Object(ObjType::Map) => Some(id),
                _ => None,
            })
    }

    /// Get or create a nested Map at ROOT.
    ///
    /// # Panics
    /// Panics if `put_object` fails, which only happens if the Automerge document
    /// is in an invalid state. This would indicate a fundamental corruption that
    /// would break all document operations - crashing is the correct response.
    #[allow(clippy::expect_used)]
    fn ensure_map(&mut self, map_key: &str) -> ObjId {
        if let Some(id) = self.get_map_id(map_key) {
            return id;
        }
        self.doc
            .put_object(automerge::ROOT, map_key, ObjType::Map)
            .expect("failed to create nested map")
    }

    // ── Aggregate accessor ───────────────────────────────────────────

    /// Get a snapshot of all settings.
    ///
    /// Reads from nested maps first, falling back to old flat keys for
    /// backward compatibility during upgrades.
    pub fn get_all(&self) -> SyncedSettings {
        let defaults = SyncedSettings::default();

        // Read uv packages: try nested list, fall back to flat comma string
        let uv_packages = {
            let nested = self.get_list("uv.default_packages");
            if !nested.is_empty() {
                nested
            } else if let Some(flat) = self.get_flat("default_uv_packages") {
                split_comma_list(&flat)
            } else {
                defaults.uv.default_packages.clone()
            }
        };

        // Read conda packages: try nested list, fall back to flat comma string
        let conda_packages = {
            let nested = self.get_list("conda.default_packages");
            if !nested.is_empty() {
                nested
            } else if let Some(flat) = self.get_flat("default_conda_packages") {
                split_comma_list(&flat)
            } else {
                defaults.conda.default_packages.clone()
            }
        };

        let default_python_env = self
            .get("default_python_env")
            .and_then(|s| s.parse().ok())
            .unwrap_or_default();
        let pool_sizes = default_pool_sizes_for_python_env(&default_python_env);

        SyncedSettings {
            theme: self
                .get("theme")
                .and_then(|s| serde_json::from_str::<ThemeMode>(&format!("\"{s}\"")).ok())
                .unwrap_or(defaults.theme),
            color_theme: self
                .get("color_theme")
                .and_then(|s| serde_json::from_str::<ColorTheme>(&format!("\"{s}\"")).ok())
                .unwrap_or(defaults.color_theme),
            default_runtime: self
                .get("default_runtime")
                .and_then(|s| s.parse().ok())
                .unwrap_or_default(),
            default_python_env,
            uv: UvDefaults {
                default_packages: uv_packages,
            },
            conda: CondaDefaults {
                default_packages: conda_packages,
            },
            pixi: PixiDefaults {
                default_packages: self.get_list("pixi.default_packages"),
            },
            keep_alive_secs: self
                .get_u64("keep_alive_secs")
                .unwrap_or(defaults.keep_alive_secs),
            // For existing users: if onboarding_completed is missing but other settings exist,
            // assume they're upgrading from before onboarding was added → treat as completed
            onboarding_completed: self.get_bool("onboarding_completed").unwrap_or_else(|| {
                // Check if this is an existing user by looking for other settings
                self.get("theme").is_some() || self.get("default_runtime").is_some()
            }),
            uv_pool_size: self
                .get_u64("uv_pool_size")
                .unwrap_or(pool_sizes.uv_pool_size),
            conda_pool_size: self
                .get_u64("conda_pool_size")
                .unwrap_or(pool_sizes.conda_pool_size),
            pixi_pool_size: self
                .get_u64("pixi_pool_size")
                .unwrap_or(pool_sizes.pixi_pool_size),
            install_default_data_packages: self
                .get_bool("install_default_data_packages")
                .unwrap_or(defaults.install_default_data_packages),
            disable_nteract_launcher: self
                .get_bool("disable_nteract_launcher")
                .unwrap_or(defaults.disable_nteract_launcher),
            disable_comments: self
                .get_bool("disable_comments")
                .unwrap_or(defaults.disable_comments),
            redact_env_values_in_outputs: self
                .get_bool("redact_env_values_in_outputs")
                .unwrap_or(defaults.redact_env_values_in_outputs),
            import_shell_environment: self
                .get_bool("import_shell_environment")
                .unwrap_or(defaults.import_shell_environment),
            install_id: self.get("install_id").unwrap_or_default(),
            telemetry_enabled: self.get_bool("telemetry_enabled").unwrap_or(true),
            telemetry_consent_recorded: self
                .get_bool("telemetry_consent_recorded")
                .unwrap_or(false),
            telemetry_last_daemon_ping_at: self.get_u64("telemetry_last_daemon_ping_at"),
            telemetry_last_app_ping_at: self.get_u64("telemetry_last_app_ping_at"),
            telemetry_last_mcp_ping_at: self.get_u64("telemetry_last_mcp_ping_at"),
        }
    }

    /// Generate a sync message to send to a peer.
    pub fn generate_sync_message(&mut self, peer_state: &mut sync::State) -> Option<sync::Message> {
        self.doc.sync().generate_sync_message(peer_state)
    }

    /// Generate a sync message while capturing Automerge panics at the document boundary.
    pub fn generate_sync_message_recovering(
        &mut self,
        label: impl Into<String>,
        peer_state: &mut sync::State,
    ) -> Result<Option<sync::Message>, AutomergeRecoveryError> {
        catch_automerge_panic(label, || {
            #[cfg(debug_assertions)]
            Self::panic_if_requested(&PANIC_ON_NEXT_GENERATE_SYNC_CALLS, "generate sync");
            self.generate_sync_message(peer_state)
        })
    }

    /// Receive and apply a sync message from a peer.
    pub fn receive_sync_message(
        &mut self,
        peer_state: &mut sync::State,
        message: sync::Message,
    ) -> Result<(), AutomergeError> {
        #[cfg(debug_assertions)]
        Self::patch_log_mismatch_if_requested(&PATCH_LOG_MISMATCH_ON_NEXT_RECEIVE_SYNC_CALLS)?;

        self.doc.sync().receive_sync_message(peer_state, message)
    }

    /// Receive a sync message while capturing Automerge panics at the document boundary.
    pub fn receive_sync_message_recovering(
        &mut self,
        label: impl Into<String>,
        peer_state: &mut sync::State,
        message: sync::Message,
    ) -> Result<(), AutomergeOperationError> {
        let label = label.into();
        match catch_automerge_result(label.clone(), || {
            #[cfg(debug_assertions)]
            Self::panic_if_requested(&PANIC_ON_NEXT_RECEIVE_SYNC_CALLS, "receive sync");
            self.receive_sync_message(peer_state, message)
        }) {
            AutomergeAttempt::Success(()) => Ok(()),
            AutomergeAttempt::OperationError(source) => {
                Err(AutomergeOperationError::automerge(label, source))
            }
            AutomergeAttempt::Panic(error) => Err(AutomergeOperationError::Panic(error)),
        }
    }

    /// Current document heads. Used to detect whether a sync exchange
    /// actually applied changes — identical heads before and after
    /// `receive_sync_message` means the peer's message was an ack or a
    /// duplicate and no broadcast is warranted.
    ///
    /// Takes `&mut` because `AutoCommit` commits any pending transaction
    /// before reporting heads.
    pub fn heads(&mut self) -> Vec<automerge::ChangeHash> {
        self.doc.get_heads()
    }

    /// Selectively apply external JSON changes to the Automerge doc.
    ///
    /// Only updates fields that are **present** in the JSON and **differ** from
    /// the current document state. Returns `true` if any field was modified.
    pub fn apply_json_changes(&mut self, json: &serde_json::Value) -> bool {
        let mut changed = false;

        // Scalar fields — only update if present in JSON and different
        for key in &[
            "theme",
            "color_theme",
            "default_runtime",
            "default_python_env",
        ] {
            if let Some(value) = json.get(key).and_then(|v| v.as_str()) {
                let current = self.get(key);
                if current.as_deref() != Some(value) {
                    info!(
                        "[settings] apply_json_changes: {key} changed {:?} -> {value:?}",
                        current.as_deref()
                    );
                    self.put(key, value);
                    changed = true;
                }
            }
        }

        // UV packages
        if json.get("uv").is_some() {
            let uv_packages = Self::extract_packages_from_json(json, "uv");
            if self.get_list("uv.default_packages") != uv_packages {
                self.put_list("uv.default_packages", &uv_packages);
                changed = true;
            }
        }

        // Conda packages
        if json.get("conda").is_some() {
            let conda_packages = Self::extract_packages_from_json(json, "conda");
            if self.get_list("conda.default_packages") != conda_packages {
                self.put_list("conda.default_packages", &conda_packages);
                changed = true;
            }
        }

        // Pixi packages
        if json.get("pixi").is_some() {
            let pixi_packages = Self::extract_packages_from_json(json, "pixi");
            if self.get_list("pixi.default_packages") != pixi_packages {
                self.put_list("pixi.default_packages", &pixi_packages);
                changed = true;
            }
        }

        // keep_alive_secs (numeric or null for forever)
        // keep_alive_secs: numeric value in seconds (invalid values are ignored)
        if let Some(new_secs) = json.get("keep_alive_secs").and_then(|v| v.as_u64()) {
            let current = self.get_u64("keep_alive_secs");
            if current != Some(new_secs) {
                info!(
                    "[settings] apply_json_changes: keep_alive_secs changed {:?} -> {}",
                    current, new_secs
                );
                self.put_u64("keep_alive_secs", new_secs);
                changed = true;
            }
        }

        // onboarding_completed: boolean
        if let Some(completed) = json.get("onboarding_completed").and_then(|v| v.as_bool()) {
            let current = self.get_bool("onboarding_completed");
            if current != Some(completed) {
                info!(
                    "[settings] apply_json_changes: onboarding_completed changed {:?} -> {}",
                    current, completed
                );
                self.put_bool("onboarding_completed", completed);
                changed = true;
            }
        }

        // Pool sizes: uv_pool_size, conda_pool_size, pixi_pool_size
        if let Some(uv_pool) = json.get("uv_pool_size").and_then(|v| v.as_u64()) {
            let current = self.get_u64("uv_pool_size");
            if current != Some(uv_pool) {
                info!(
                    "[settings] apply_json_changes: uv_pool_size changed {:?} -> {}",
                    current, uv_pool
                );
                self.put_u64("uv_pool_size", uv_pool);
                changed = true;
            }
        }
        if let Some(conda_pool) = json.get("conda_pool_size").and_then(|v| v.as_u64()) {
            let current = self.get_u64("conda_pool_size");
            if current != Some(conda_pool) {
                info!(
                    "[settings] apply_json_changes: conda_pool_size changed {:?} -> {}",
                    current, conda_pool
                );
                self.put_u64("conda_pool_size", conda_pool);
                changed = true;
            }
        }
        if let Some(pixi_pool) = json.get("pixi_pool_size").and_then(|v| v.as_u64()) {
            let current = self.get_u64("pixi_pool_size");
            if current != Some(pixi_pool) {
                info!(
                    "[settings] apply_json_changes: pixi_pool_size changed {:?} -> {}",
                    current, pixi_pool
                );
                self.put_u64("pixi_pool_size", pixi_pool);
                changed = true;
            }
        }

        // disable_nteract_launcher: boolean
        if let Some(disabled) = json
            .get("disable_nteract_launcher")
            .and_then(|v| v.as_bool())
        {
            let current = self.get_bool("disable_nteract_launcher");
            if current != Some(disabled) {
                info!(
                    "[settings] apply_json_changes: disable_nteract_launcher changed {:?} -> {}",
                    current, disabled
                );
                self.put_bool("disable_nteract_launcher", disabled);
                changed = true;
            }
        }
        // disable_comments: boolean
        if let Some(disabled) = json.get("disable_comments").and_then(|v| v.as_bool()) {
            let current = self.get_bool("disable_comments");
            if current != Some(disabled) {
                info!(
                    "[settings] apply_json_changes: disable_comments changed {:?} -> {}",
                    current, disabled
                );
                self.put_bool("disable_comments", disabled);
                changed = true;
            }
        }
        if let Some(enabled) = json
            .get("redact_env_values_in_outputs")
            .and_then(|v| v.as_bool())
        {
            let current = self.get_bool("redact_env_values_in_outputs");
            if current != Some(enabled) {
                info!(
                    "[settings] apply_json_changes: redact_env_values_in_outputs changed {:?} -> {}",
                    current, enabled
                );
                self.put_bool("redact_env_values_in_outputs", enabled);
                changed = true;
            }
        }
        if let Some(enabled) = json
            .get("import_shell_environment")
            .and_then(|v| v.as_bool())
        {
            let current = self.get_bool("import_shell_environment");
            if current != Some(enabled) {
                info!(
                    "[settings] apply_json_changes: import_shell_environment changed {:?} -> {}",
                    current, enabled
                );
                self.put_bool("import_shell_environment", enabled);
                changed = true;
            }
        }
        if let Some(enabled) = json
            .get("install_default_data_packages")
            .and_then(|v| v.as_bool())
        {
            let current = self.get_bool("install_default_data_packages");
            if current != Some(enabled) {
                info!(
                    "[settings] apply_json_changes: install_default_data_packages changed {:?} -> {}",
                    current, enabled
                );
                self.put_bool("install_default_data_packages", enabled);
                changed = true;
            }
        }

        // Telemetry fields
        if let Some(id) = json.get("install_id").and_then(|v| v.as_str()) {
            if !id.is_empty() {
                let current = self.get("install_id");
                if current.as_deref() != Some(id) {
                    self.put("install_id", id);
                    changed = true;
                }
            }
        }
        if let Some(enabled) = json.get("telemetry_enabled").and_then(|v| v.as_bool()) {
            if self.get_bool("telemetry_enabled") != Some(enabled) {
                self.put_bool("telemetry_enabled", enabled);
                changed = true;
            }
        }
        if let Some(recorded) = json
            .get("telemetry_consent_recorded")
            .and_then(|v| v.as_bool())
        {
            if self.get_bool("telemetry_consent_recorded") != Some(recorded) {
                self.put_bool("telemetry_consent_recorded", recorded);
                changed = true;
            }
        }
        for key in &[
            "telemetry_last_daemon_ping_at",
            "telemetry_last_app_ping_at",
            "telemetry_last_mcp_ping_at",
        ] {
            if let Some(ts) = json.get(key).and_then(|v| v.as_u64()) {
                if self.get_u64(key) != Some(ts) {
                    self.put_u64(key, ts);
                    changed = true;
                }
            }
        }

        changed
    }

    #[cfg(debug_assertions)]
    #[doc(hidden)]
    pub fn __panic_on_next_generate_sync_calls_for_test(count: usize) {
        PANIC_ON_NEXT_GENERATE_SYNC_CALLS.store(count, Ordering::SeqCst);
    }

    #[cfg(debug_assertions)]
    #[doc(hidden)]
    pub fn __panic_on_next_receive_sync_calls_for_test(count: usize) {
        PANIC_ON_NEXT_RECEIVE_SYNC_CALLS.store(count, Ordering::SeqCst);
    }

    #[cfg(debug_assertions)]
    #[doc(hidden)]
    pub fn __patch_log_mismatch_on_next_receive_sync_calls_for_test(count: usize) {
        PATCH_LOG_MISMATCH_ON_NEXT_RECEIVE_SYNC_CALLS.store(count, Ordering::SeqCst);
    }

    #[cfg(debug_assertions)]
    #[doc(hidden)]
    pub fn __reset_sync_failure_hooks_for_test() {
        PANIC_ON_NEXT_GENERATE_SYNC_CALLS.store(0, Ordering::SeqCst);
        PANIC_ON_NEXT_RECEIVE_SYNC_CALLS.store(0, Ordering::SeqCst);
        PATCH_LOG_MISMATCH_ON_NEXT_RECEIVE_SYNC_CALLS.store(0, Ordering::SeqCst);
    }

    #[cfg(debug_assertions)]
    fn panic_if_requested(counter: &AtomicUsize, operation: &str) {
        if counter
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |count| {
                count.checked_sub(1)
            })
            .is_ok()
        {
            panic!("injected settings {operation} panic");
        }
    }

    #[cfg(debug_assertions)]
    fn patch_log_mismatch_if_requested(counter: &AtomicUsize) -> Result<(), AutomergeError> {
        if counter
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |count| {
                count.checked_sub(1)
            })
            .is_ok()
        {
            return Err(automerge::PatchLogMismatch.into());
        }
        Ok(())
    }
}

impl Default for SettingsDoc {
    fn default() -> Self {
        Self::new()
    }
}

// ── Free helpers ─────────────────────────────────────────────────────

/// Read a scalar string value from any Automerge object.
fn read_scalar_str<O: AsRef<ObjId>>(doc: &AutoCommit, obj: O, key: &str) -> Option<String> {
    doc.get(obj, key)
        .ok()
        .flatten()
        .and_then(|(value, _)| match value {
            automerge::Value::Scalar(s) => match s.as_ref() {
                automerge::ScalarValue::Str(s) => Some(s.to_string()),
                _ => None,
            },
            _ => None,
        })
}

/// Split a comma-separated string into a list of trimmed, non-empty strings.
pub fn split_comma_list(s: &str) -> Vec<String> {
    s.split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// Read a list of strings from a nested Automerge map within a raw `AutoCommit`.
///
/// Used by `sync_client::get_all_from_doc` which operates on bare docs.
pub fn read_nested_list(doc: &AutoCommit, map_key: &str, sub_key: &str) -> Vec<String> {
    let map_id = match doc.get(automerge::ROOT, map_key).ok().flatten() {
        Some((automerge::Value::Object(ObjType::Map), id)) => id,
        _ => return vec![],
    };
    let list_id = match doc.get(&map_id, sub_key).ok().flatten() {
        Some((automerge::Value::Object(ObjType::List), id)) => id,
        _ => return vec![],
    };
    let len = doc.length(&list_id);
    (0..len)
        .filter_map(|i| {
            doc.get(&list_id, i)
                .ok()
                .flatten()
                .and_then(|(value, _)| match value {
                    automerge::Value::Scalar(s) => match s.as_ref() {
                        automerge::ScalarValue::Str(s) => Some(s.to_string()),
                        _ => None,
                    },
                    _ => None,
                })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;
    use tempfile::TempDir;

    struct SettingsSyncFailureHookGuard;

    impl SettingsSyncFailureHookGuard {
        fn new() -> Self {
            SettingsDoc::__reset_sync_failure_hooks_for_test();
            Self
        }
    }

    impl Drop for SettingsSyncFailureHookGuard {
        fn drop(&mut self) {
            SettingsDoc::__reset_sync_failure_hooks_for_test();
        }
    }

    #[test]
    fn test_new_has_defaults() {
        let doc = SettingsDoc::new();
        let settings = doc.get_all();
        assert_eq!(settings.theme, ThemeMode::System);
        assert_eq!(settings.default_runtime, Runtime::Python);
        assert_eq!(settings.default_python_env, PythonEnvType::Uv);
        assert_eq!(settings.uv_pool_size, DEFAULT_SELECTED_POOL_SIZE);
        assert_eq!(settings.conda_pool_size, DEFAULT_POOL_SIZE);
        assert_eq!(settings.pixi_pool_size, DEFAULT_POOL_SIZE);
        assert!(settings.uv.default_packages.is_empty());
        assert!(settings.conda.default_packages.is_empty());
        assert!(settings.pixi.default_packages.is_empty());
        assert!(settings.install_default_data_packages);
        assert!(!settings.disable_nteract_launcher);
        assert!(!settings.disable_comments);
        assert!(settings.feature_flags().bootstrap_dx);
        assert!(settings.redact_env_values_in_outputs);
    }

    #[test]
    fn test_selected_python_env_gets_larger_default_pool() {
        let mut doc = SettingsDoc::new();
        doc.put("default_python_env", "conda");
        let settings = doc.get_all();
        assert_eq!(settings.uv_pool_size, DEFAULT_POOL_SIZE);
        assert_eq!(settings.conda_pool_size, DEFAULT_SELECTED_POOL_SIZE);
        assert_eq!(settings.pixi_pool_size, DEFAULT_POOL_SIZE);

        doc.put("default_python_env", "pixi");
        let settings = doc.get_all();
        assert_eq!(settings.uv_pool_size, DEFAULT_POOL_SIZE);
        assert_eq!(settings.conda_pool_size, DEFAULT_POOL_SIZE);
        assert_eq!(settings.pixi_pool_size, DEFAULT_SELECTED_POOL_SIZE);
    }

    #[test]
    fn test_explicit_pool_sizes_override_selected_env_defaults() {
        let mut doc = SettingsDoc::new();
        doc.put("default_python_env", "pixi");
        doc.put_u64("uv_pool_size", 4);
        doc.put_u64("conda_pool_size", 5);
        doc.put_u64("pixi_pool_size", 6);

        let settings = doc.get_all();
        assert_eq!(settings.uv_pool_size, 4);
        assert_eq!(settings.conda_pool_size, 5);
        assert_eq!(settings.pixi_pool_size, 6);
    }

    #[test]
    fn test_apply_json_changes_persists_pool_size_matching_dynamic_default() {
        let mut doc = SettingsDoc::new();

        assert!(doc.apply_json_changes(&serde_json::json!({
            "uv_pool_size": DEFAULT_SELECTED_POOL_SIZE
        })));
        assert_eq!(
            doc.get_u64("uv_pool_size"),
            Some(DEFAULT_SELECTED_POOL_SIZE)
        );

        assert!(doc.apply_json_changes(&serde_json::json!({
            "default_python_env": "conda"
        })));
        assert_eq!(doc.get_all().uv_pool_size, DEFAULT_SELECTED_POOL_SIZE);
    }

    #[test]
    fn test_install_default_data_packages_can_be_disabled_from_json() {
        let mut doc = SettingsDoc::new();

        assert!(doc.apply_json_changes(&serde_json::json!({
            "install_default_data_packages": false
        })));

        assert_eq!(doc.get_bool("install_default_data_packages"), Some(false));
        assert!(!doc.get_all().install_default_data_packages);
    }

    #[test]
    fn test_disable_nteract_launcher_can_be_enabled_from_json() {
        let mut doc = SettingsDoc::new();

        assert!(doc.apply_json_changes(&serde_json::json!({
            "disable_nteract_launcher": true
        })));

        let settings = doc.get_all();
        assert_eq!(doc.get_bool("disable_nteract_launcher"), Some(true));
        assert!(settings.disable_nteract_launcher);
        assert!(!settings.feature_flags().bootstrap_dx);
    }

    #[test]
    fn test_disable_comments_can_be_enabled_from_json() {
        let mut doc = SettingsDoc::new();

        assert!(doc.apply_json_changes(&serde_json::json!({
            "disable_comments": true
        })));

        let settings = doc.get_all();
        assert_eq!(doc.get_bool("disable_comments"), Some(true));
        assert!(settings.disable_comments);
    }

    #[test]
    fn test_legacy_bootstrap_dx_false_does_not_disable_launcher() {
        let doc = SettingsDoc::from_json_value(&serde_json::json!({
            "bootstrap_dx": false
        }));

        let settings = doc.get_all();
        assert!(!settings.disable_nteract_launcher);
        assert!(settings.feature_flags().bootstrap_dx);
    }

    #[test]
    fn test_redact_env_values_in_outputs_can_be_disabled_from_json() {
        let mut doc = SettingsDoc::new();

        assert!(doc.apply_json_changes(&serde_json::json!({
            "redact_env_values_in_outputs": false
        })));

        assert_eq!(doc.get_bool("redact_env_values_in_outputs"), Some(false));
        assert!(!doc.get_all().redact_env_values_in_outputs);
    }

    #[test]
    fn test_backfill_telemetry_consent_flips_for_onboarded_users() {
        let mut s = SyncedSettings {
            onboarding_completed: true,
            telemetry_consent_recorded: false,
            ..Default::default()
        };
        assert!(backfill_telemetry_consent(&mut s));
        assert!(s.telemetry_consent_recorded);
    }

    #[test]
    fn test_backfill_telemetry_consent_noop_for_fresh_installs() {
        let mut s = SyncedSettings::default();
        // onboarding_completed defaults to false
        assert!(!backfill_telemetry_consent(&mut s));
        assert!(!s.telemetry_consent_recorded);
    }

    #[test]
    fn test_ensure_install_id_in_settings_generates_once() {
        let mut s = SyncedSettings::default();

        let (id, generated) = ensure_install_id_in_settings(&mut s);
        assert!(generated);
        assert!(!id.is_empty());
        assert_eq!(s.install_id, id);

        let (again, generated) = ensure_install_id_in_settings(&mut s);
        assert!(!generated);
        assert_eq!(again, id);
    }

    #[test]
    fn test_backfill_telemetry_consent_in_doc_flips_once() {
        let mut doc = SettingsDoc::new();
        doc.put_bool("onboarding_completed", true);
        // Default: consent_recorded is false
        assert!(!doc.get_bool("telemetry_consent_recorded").unwrap_or(false));

        // First call flips it and returns true
        assert!(backfill_telemetry_consent_in_doc(&mut doc));
        assert!(doc.get_bool("telemetry_consent_recorded").unwrap_or(false));

        // Second call is a no-op and returns false
        assert!(!backfill_telemetry_consent_in_doc(&mut doc));
    }

    #[test]
    fn test_backfill_telemetry_consent_in_doc_noop_for_fresh_installs() {
        let mut doc = SettingsDoc::new();
        // onboarding_completed is false in a fresh doc; backfill must not
        // synthesize consent that was never given.
        assert!(!backfill_telemetry_consent_in_doc(&mut doc));
        assert!(!doc.get_bool("telemetry_consent_recorded").unwrap_or(false));
    }

    #[test]
    fn test_put_and_get_scalar() {
        let mut doc = SettingsDoc::new();
        doc.put("theme", "dark");
        assert_eq!(doc.get("theme"), Some("dark".to_string()));
    }

    #[test]
    fn test_get_nonexistent_key() {
        let doc = SettingsDoc::new();
        assert_eq!(doc.get("nonexistent"), None);
    }

    #[test]
    fn test_put_and_get_list() {
        let mut doc = SettingsDoc::new();
        doc.put_list(
            "uv.default_packages",
            &["numpy".to_string(), "pandas".to_string()],
        );

        let packages = doc.get_list("uv.default_packages");
        assert_eq!(packages, vec!["numpy", "pandas"]);
    }

    #[test]
    fn test_put_list_replaces_existing() {
        let mut doc = SettingsDoc::new();
        doc.put_list("uv.default_packages", &["numpy".to_string()]);
        doc.put_list(
            "uv.default_packages",
            &["pandas".to_string(), "scipy".to_string()],
        );

        let packages = doc.get_list("uv.default_packages");
        assert_eq!(packages, vec!["pandas", "scipy"]);
    }

    #[test]
    fn test_get_list_empty_by_default() {
        let doc = SettingsDoc::new();
        let packages = doc.get_list("uv.default_packages");
        assert!(packages.is_empty());
    }

    #[test]
    fn test_put_value_string() {
        let mut doc = SettingsDoc::new();
        doc.put_value("theme", &serde_json::json!("dark"));
        assert_eq!(doc.get("theme"), Some("dark".to_string()));
    }

    #[test]
    fn test_put_value_array() {
        let mut doc = SettingsDoc::new();
        doc.put_value(
            "uv.default_packages",
            &serde_json::json!(["numpy", "pandas"]),
        );
        assert_eq!(doc.get_list("uv.default_packages"), vec!["numpy", "pandas"]);
    }

    #[test]
    fn test_get_all_with_packages() {
        let mut doc = SettingsDoc::new();
        doc.put_list(
            "uv.default_packages",
            &["numpy".to_string(), "pandas".to_string()],
        );
        doc.put_list("conda.default_packages", &["scipy".to_string()]);

        let settings = doc.get_all();
        assert_eq!(settings.uv.default_packages, vec!["numpy", "pandas"]);
        assert_eq!(settings.conda.default_packages, vec!["scipy"]);
    }

    #[test]
    fn test_save_and_load() {
        let mut doc = SettingsDoc::new();
        doc.put("theme", "light");
        doc.put_list("uv.default_packages", &["numpy".to_string()]);

        let bytes = doc.save();
        let loaded = SettingsDoc::load(&bytes).unwrap();

        assert_eq!(loaded.get("theme"), Some("light".to_string()));
        assert_eq!(loaded.get("default_runtime"), Some("python".to_string()));
        assert_eq!(loaded.get_list("uv.default_packages"), vec!["numpy"]);
    }

    #[test]
    fn test_save_to_file_and_load_or_create() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("settings.automerge");

        let mut doc = SettingsDoc::new();
        doc.put("theme", "dark");
        doc.put_list(
            "conda.default_packages",
            &["scipy".to_string(), "numpy".to_string()],
        );
        doc.save_to_file(&path).unwrap();

        let loaded = SettingsDoc::load_or_create(&path, None);
        assert_eq!(loaded.get("theme"), Some("dark".to_string()));
        assert_eq!(
            loaded.get_list("conda.default_packages"),
            vec!["scipy", "numpy"]
        );
    }

    #[test]
    fn test_migrate_flat_to_nested() {
        // Simulate an old Automerge doc with flat comma-separated keys
        let mut doc = AutoCommit::new();
        let _ = doc.put(automerge::ROOT, "theme", "dark");
        let _ = doc.put(automerge::ROOT, "default_runtime", "python");
        let _ = doc.put(automerge::ROOT, "default_python_env", "uv");
        let _ = doc.put(
            automerge::ROOT,
            "default_uv_packages",
            "numpy, pandas, matplotlib",
        );
        let _ = doc.put(automerge::ROOT, "default_conda_packages", "scipy");

        let bytes = doc.save();

        // Load via load_or_create which triggers migration
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("settings.automerge");
        std::fs::write(&path, bytes).unwrap();

        let loaded = SettingsDoc::load_or_create(&path, None);
        let settings = loaded.get_all();

        assert_eq!(settings.theme, ThemeMode::Dark);
        assert_eq!(
            settings.uv.default_packages,
            vec!["numpy", "pandas", "matplotlib"]
        );
        assert_eq!(settings.conda.default_packages, vec!["scipy"]);

        // Old flat keys should be gone
        assert_eq!(loaded.get_flat("default_uv_packages"), None);
        assert_eq!(loaded.get_flat("default_conda_packages"), None);
    }

    #[test]
    fn test_migrate_from_json_nested_format() {
        let tmp = TempDir::new().unwrap();
        let automerge_path = tmp.path().join("settings.automerge");
        let json_path = tmp.path().join("settings.json");

        // Write new-format settings.json
        std::fs::write(
            &json_path,
            r#"{"default_runtime":"python","uv":{"default_packages":["numpy","pandas"]},"conda":{"default_packages":["scipy"]}}"#,
        )
        .unwrap();

        let doc = SettingsDoc::load_or_create(&automerge_path, Some(&json_path));
        let settings = doc.get_all();

        assert_eq!(settings.uv.default_packages, vec!["numpy", "pandas"]);
        assert_eq!(settings.conda.default_packages, vec!["scipy"]);
    }

    #[test]
    fn test_load_or_create_prefers_json_over_existing_automerge_doc() {
        let tmp = TempDir::new().unwrap();
        let automerge_path = tmp.path().join("settings.automerge");
        let json_path = tmp.path().join("settings.json");

        let mut stale_doc = SettingsDoc::new();
        stale_doc.put("default_python_env", "uv");
        stale_doc.save_to_file(&automerge_path).unwrap();

        std::fs::write(
            &json_path,
            r#"{"default_python_env":"conda","uv":{"default_packages":["numpy"]}}"#,
        )
        .unwrap();

        let reconciled = SettingsDoc::load_or_create(&automerge_path, Some(&json_path));
        assert_eq!(
            reconciled.get("default_python_env").as_deref(),
            Some("conda")
        );

        let persisted = SettingsDoc::load_or_create(&automerge_path, None);
        assert_eq!(
            persisted.get("default_python_env").as_deref(),
            Some("uv"),
            "loading canonical settings.json must not rewrite the legacy Automerge file"
        );
        assert_eq!(
            persisted.get_list("uv.default_packages"),
            Vec::<String>::new()
        );
    }

    #[test]
    fn test_load_or_create_migrates_legacy_automerge_to_json_when_json_missing() {
        let tmp = TempDir::new().unwrap();
        let automerge_path = tmp.path().join("settings.automerge");
        let json_path = tmp.path().join("settings.json");

        let mut legacy_doc = SettingsDoc::new();
        legacy_doc.put("default_python_env", "conda");
        legacy_doc.put_list("uv.default_packages", &["numpy".to_string()]);
        legacy_doc.save_to_file(&automerge_path).unwrap();

        let migrated = SettingsDoc::load_or_create(&automerge_path, Some(&json_path));
        assert_eq!(migrated.get("default_python_env").as_deref(), Some("conda"));

        let saved_json = std::fs::read_to_string(&json_path).unwrap();
        let saved: SyncedSettings = serde_json::from_str(&saved_json).unwrap();
        assert_eq!(saved.default_python_env, PythonEnvType::Conda);
        assert_eq!(saved.uv.default_packages, vec!["numpy"]);
    }

    #[test]
    fn test_load_or_create_recovers_from_invalid_json_with_legacy_automerge() {
        let tmp = TempDir::new().unwrap();
        let automerge_path = tmp.path().join("settings.automerge");
        let json_path = tmp.path().join("settings.json");

        let mut legacy_doc = SettingsDoc::new();
        legacy_doc.put("default_python_env", "pixi");
        legacy_doc.put_list("conda.default_packages", &["scipy".to_string()]);
        legacy_doc.save_to_file(&automerge_path).unwrap();
        std::fs::write(&json_path, "{ not valid json").unwrap();

        let recovered = SettingsDoc::load_or_create(&automerge_path, Some(&json_path));
        assert_eq!(recovered.get("default_python_env").as_deref(), Some("pixi"));

        let saved_json = std::fs::read_to_string(&json_path).unwrap();
        let saved: SyncedSettings = serde_json::from_str(&saved_json).unwrap();
        assert_eq!(saved.default_python_env, PythonEnvType::Pixi);
        assert_eq!(saved.conda.default_packages, vec!["scipy"]);
    }

    #[test]
    fn test_load_or_create_repairs_invalid_json_without_legacy_automerge() {
        let tmp = TempDir::new().unwrap();
        let automerge_path = tmp.path().join("settings.automerge");
        let json_path = tmp.path().join("settings.json");

        std::fs::write(&json_path, "{ not valid json").unwrap();

        let recovered = SettingsDoc::load_or_create(&automerge_path, Some(&json_path));
        assert_eq!(recovered.get_all(), SyncedSettings::default());

        let saved_json = std::fs::read_to_string(&json_path).unwrap();
        let saved: SyncedSettings = serde_json::from_str(&saved_json).unwrap();
        assert_eq!(saved, SyncedSettings::default());
    }

    #[test]
    fn test_load_or_create_defaults() {
        let tmp = TempDir::new().unwrap();
        let automerge_path = tmp.path().join("settings.automerge");

        let doc = SettingsDoc::load_or_create(&automerge_path, None);
        assert_eq!(doc.get_all(), SyncedSettings::default());
    }

    #[test]
    fn test_json_mirror() {
        let tmp = TempDir::new().unwrap();
        let json_path = tmp.path().join("settings.json");

        let mut doc = SettingsDoc::new();
        doc.put("theme", "dark");
        doc.put_list(
            "uv.default_packages",
            &["numpy".to_string(), "pandas".to_string()],
        );
        doc.save_json_mirror(&json_path).unwrap();

        let contents = std::fs::read_to_string(&json_path).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&contents).unwrap();
        assert_eq!(parsed["$schema"], "./settings.schema.json");
        assert_eq!(parsed["theme"], "dark");
        assert_eq!(parsed["uv"]["default_packages"][0], "numpy");
        assert_eq!(parsed["uv"]["default_packages"][1], "pandas");
    }

    #[test]
    fn test_apply_json_changes_ignores_schema_key() {
        let mut doc = SettingsDoc::new();
        let json = serde_json::json!({
            "$schema": "./settings.schema.json",
            "theme": "dark",
        });
        let changed = doc.apply_json_changes(&json);
        assert!(changed);
        assert_eq!(doc.get("theme"), Some("dark".to_string()));
    }

    #[test]
    fn test_generate_settings_schema() {
        let schema = generate_settings_schema().unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&schema).unwrap();
        // Should be a valid JSON Schema with properties
        let schema_str = &schema;
        assert!(schema_str.contains("theme"));
        assert!(schema_str.contains("default_runtime"));
        assert!(schema_str.contains("default_python_env"));
        assert!(schema_str.contains("install_default_data_packages"));
        assert!(schema_str.contains("disable_nteract_launcher"));
        assert!(schema_str.contains("disable_comments"));
        assert!(schema_str.contains("redact_env_values_in_outputs"));
        // Should have known values as examples for editor autocomplete
        assert!(schema_str.contains("python"));
        assert!(schema_str.contains("deno"));
        assert!(schema_str.contains("uv"));
        assert!(schema_str.contains("conda"));
        // Should be a proper JSON Schema object
        assert!(parsed.is_object());
    }

    #[test]
    fn test_schema_key_ignored_during_deserialization() {
        let json = r#"{
            "$schema": "./settings.schema.json",
            "theme": "dark",
            "default_runtime": "deno",
            "default_python_env": "conda",
            "uv": { "default_packages": [] },
            "conda": { "default_packages": [] }
        }"#;
        let parsed: SyncedSettings = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.theme, ThemeMode::Dark);
        assert_eq!(parsed.default_runtime, Runtime::Deno);
        assert_eq!(parsed.default_python_env, PythonEnvType::Conda);
    }

    #[test]
    fn test_sync_between_two_docs() {
        let mut server = SettingsDoc::new();
        server.put("theme", "dark");
        server.put_list("uv.default_packages", &["numpy".to_string()]);

        // Client starts empty — avoids conflicting object creation for nested
        // maps (both docs creating their own "uv" Map independently would cause
        // Automerge CRDT conflicts that resolve nondeterministically).
        let mut client = SettingsDoc {
            doc: AutoCommit::new(),
        };

        let mut server_state = sync::State::new();
        let mut client_state = sync::State::new();

        for _ in 0..10 {
            if let Some(msg) = client.generate_sync_message(&mut client_state) {
                server.receive_sync_message(&mut server_state, msg).unwrap();
            }
            if let Some(msg) = server.generate_sync_message(&mut server_state) {
                client.receive_sync_message(&mut client_state, msg).unwrap();
            }
        }

        assert_eq!(client.get("theme"), Some("dark".to_string()));
        assert_eq!(client.get("default_runtime"), Some("python".to_string()));
        assert_eq!(client.get_list("uv.default_packages"), vec!["numpy"]);
    }

    #[test]
    fn test_concurrent_writes_merge() {
        let mut server = SettingsDoc::new();
        let mut client = SettingsDoc::new();

        let mut server_state = sync::State::new();
        let mut client_state = sync::State::new();

        // Sync initial state
        for _ in 0..10 {
            if let Some(msg) = client.generate_sync_message(&mut client_state) {
                server.receive_sync_message(&mut server_state, msg).unwrap();
            }
            if let Some(msg) = server.generate_sync_message(&mut server_state) {
                client.receive_sync_message(&mut client_state, msg).unwrap();
            }
        }

        // Both make different changes
        server.put("theme", "dark");
        client.put("default_runtime", "deno");

        // Sync again
        for _ in 0..10 {
            if let Some(msg) = client.generate_sync_message(&mut client_state) {
                server.receive_sync_message(&mut server_state, msg).unwrap();
            }
            if let Some(msg) = server.generate_sync_message(&mut server_state) {
                client.receive_sync_message(&mut client_state, msg).unwrap();
            }
        }

        assert_eq!(server.get("theme"), Some("dark".to_string()));
        assert_eq!(server.get("default_runtime"), Some("deno".to_string()));
        assert_eq!(client.get("theme"), Some("dark".to_string()));
        assert_eq!(client.get("default_runtime"), Some("deno".to_string()));
    }

    #[test]
    fn test_split_comma_list() {
        assert_eq!(
            split_comma_list("numpy, pandas, matplotlib"),
            vec!["numpy", "pandas", "matplotlib"]
        );
        assert_eq!(split_comma_list(""), Vec::<String>::new());
        assert_eq!(split_comma_list("  "), Vec::<String>::new());
        assert_eq!(split_comma_list("numpy"), vec!["numpy"]);
    }

    #[test]
    fn test_nested_scalar_in_map() {
        let mut doc = SettingsDoc::new();
        // Write a scalar into a nested map (for future settings like conda channels)
        doc.put("uv.some_future_setting", "value");
        assert_eq!(doc.get("uv.some_future_setting"), Some("value".to_string()));
    }

    #[test]
    fn test_ensure_map_creates_if_missing() {
        let mut doc = SettingsDoc::new();
        // Put into a map that doesn't exist yet
        doc.put("new_section.key", "value");
        assert_eq!(doc.get("new_section.key"), Some("value".to_string()));
    }

    #[test]
    fn test_apply_json_changes_detects_difference() {
        let mut doc = SettingsDoc::new();
        assert_eq!(doc.get("theme"), Some("system".to_string()));

        let json = serde_json::json!({
            "theme": "dark",
            "default_runtime": "deno",
        });
        let changed = doc.apply_json_changes(&json);
        assert!(changed);
        assert_eq!(doc.get("theme"), Some("dark".to_string()));
        assert_eq!(doc.get("default_runtime"), Some("deno".to_string()));
        // Unchanged fields stay the same
        assert_eq!(doc.get("default_python_env"), Some("uv".to_string()));
    }

    #[test]
    fn test_apply_json_changes_no_change_when_matching() {
        let mut doc = SettingsDoc::new();
        doc.put_u64("uv_pool_size", DEFAULT_SELECTED_POOL_SIZE);
        doc.put_u64("conda_pool_size", DEFAULT_POOL_SIZE);
        doc.put_u64("pixi_pool_size", DEFAULT_POOL_SIZE);
        let settings = doc.get_all();

        // Write current persisted values back — should detect no change.
        let json = serde_json::to_value(&settings).unwrap();
        let changed = doc.apply_json_changes(&json);
        assert!(!changed);
    }

    #[test]
    fn test_apply_json_changes_skips_absent_fields() {
        let mut doc = SettingsDoc::new();
        doc.put("theme", "dark");

        // JSON without theme key — should NOT reset theme
        let json = serde_json::json!({
            "default_runtime": "python",
        });
        let changed = doc.apply_json_changes(&json);
        assert!(!changed); // runtime already "python"
        assert_eq!(doc.get("theme"), Some("dark".to_string())); // preserved
    }

    #[test]
    fn test_apply_json_changes_nested_packages() {
        let mut doc = SettingsDoc::new();

        let json = serde_json::json!({
            "uv": { "default_packages": ["numpy", "pandas"] },
            "conda": { "default_packages": ["scipy"] },
            "pixi": { "default_packages": ["polars"] },
        });
        let changed = doc.apply_json_changes(&json);
        assert!(changed);
        assert_eq!(doc.get_list("uv.default_packages"), vec!["numpy", "pandas"]);
        assert_eq!(doc.get_list("conda.default_packages"), vec!["scipy"]);
        assert_eq!(doc.get_list("pixi.default_packages"), vec!["polars"]);
    }

    #[test]
    fn test_apply_json_changes_packages_no_change() {
        let mut doc = SettingsDoc::new();
        doc.put_list(
            "uv.default_packages",
            &["numpy".to_string(), "pandas".to_string()],
        );

        // Same packages — should detect no change
        let json = serde_json::json!({
            "uv": { "default_packages": ["numpy", "pandas"] },
        });
        let changed = doc.apply_json_changes(&json);
        assert!(!changed);
    }

    #[test]
    fn test_keep_alive_secs_valid_number() {
        let mut doc = SettingsDoc::new();
        doc.put_u64("keep_alive_secs", 60);

        let result = doc.get_u64("keep_alive_secs");
        assert_eq!(result, Some(60));

        let settings = doc.get_all();
        assert_eq!(settings.keep_alive_secs, 60);
    }

    #[test]
    fn test_keep_alive_secs_default() {
        let doc = SettingsDoc::new();
        let settings = doc.get_all();

        // Default should be 30 seconds
        assert_eq!(settings.keep_alive_secs, DEFAULT_KEEP_ALIVE_SECS);
    }

    #[test]
    fn test_apply_json_changes_keep_alive_valid_number() {
        let mut doc = SettingsDoc::new();

        let json = serde_json::json!({
            "keep_alive_secs": 120
        });
        let changed = doc.apply_json_changes(&json);
        assert!(changed);

        let settings = doc.get_all();
        assert_eq!(settings.keep_alive_secs, 120);
    }

    #[test]
    fn test_apply_json_changes_keep_alive_invalid_ignored() {
        let mut doc = SettingsDoc::new();
        // Set a known value first
        doc.put_u64("keep_alive_secs", 60);

        // Invalid values should be ignored
        // Test negative number (can't be represented as u64 in JSON)
        let json = serde_json::json!({
            "keep_alive_secs": -1
        });
        let changed = doc.apply_json_changes(&json);
        assert!(!changed); // Should be no change

        let settings = doc.get_all();
        assert_eq!(settings.keep_alive_secs, 60); // Original preserved

        // Test string value
        let json = serde_json::json!({
            "keep_alive_secs": "30"
        });
        let changed = doc.apply_json_changes(&json);
        assert!(!changed);

        let settings = doc.get_all();
        assert_eq!(settings.keep_alive_secs, 60); // Original preserved

        // Test null value (should be ignored, not treated specially)
        let json = serde_json::json!({
            "keep_alive_secs": null
        });
        let changed = doc.apply_json_changes(&json);
        assert!(!changed);

        let settings = doc.get_all();
        assert_eq!(settings.keep_alive_secs, 60); // Original preserved
    }

    #[test]
    fn test_get_u64_negative_int_returns_none() {
        use automerge::AutoCommit;

        // Manually create a doc with a negative Int value
        let mut automerge_doc = AutoCommit::new();
        let _ = automerge_doc.put(automerge::ROOT, "keep_alive_secs", -5_i64);

        // Wrap in SettingsDoc
        let doc = SettingsDoc { doc: automerge_doc };

        // Negative Int should return None (invalid)
        let result = doc.get_u64("keep_alive_secs");
        assert_eq!(result, None);
    }

    #[test]
    fn test_migrate_null_keep_alive_to_max() {
        use automerge::AutoCommit;

        // Manually create a doc with null keep_alive_secs (legacy "forever" mode)
        let mut automerge_doc = AutoCommit::new();
        let _ = automerge_doc.put(
            automerge::ROOT,
            "keep_alive_secs",
            automerge::ScalarValue::Null,
        );

        let mut doc = SettingsDoc { doc: automerge_doc };

        // Verify it's detected as null
        assert!(doc.is_null("keep_alive_secs"));
        assert_eq!(doc.get_u64("keep_alive_secs"), None);

        // Run migration
        doc.migrate_null_keep_alive();

        // Should now be MAX_KEEP_ALIVE_SECS
        assert!(!doc.is_null("keep_alive_secs"));
        assert_eq!(doc.get_u64("keep_alive_secs"), Some(MAX_KEEP_ALIVE_SECS));

        let settings = doc.get_all();
        assert_eq!(settings.keep_alive_secs, MAX_KEEP_ALIVE_SECS);
    }

    #[test]
    fn test_from_json_null_keep_alive_migrates_to_max() {
        // JSON with null keep_alive_secs (legacy "forever" mode)
        let json = serde_json::json!({
            "theme": "dark",
            "keep_alive_secs": null
        });

        let doc = SettingsDoc::from_json_value(&json);
        let settings = doc.get_all();

        // Should be MAX_KEEP_ALIVE_SECS, not the default 30s
        assert_eq!(settings.keep_alive_secs, MAX_KEEP_ALIVE_SECS);
        assert_eq!(settings.theme, ThemeMode::Dark);
    }

    #[test]
    fn test_from_json_value_imports_color_theme_and_pixi_packages() {
        let json = serde_json::json!({
            "theme": "dark",
            "color_theme": "cream",
            "pixi": { "default_packages": ["numpy", "polars"] },
        });

        let doc = SettingsDoc::from_json_value(&json);
        let settings = doc.get_all();

        assert_eq!(settings.theme, ThemeMode::Dark);
        assert_eq!(settings.color_theme, ColorTheme::Cream);
        assert_eq!(
            settings.pixi.default_packages,
            vec!["numpy".to_string(), "polars".to_string()]
        );
    }

    #[test]
    fn test_from_synced_settings_round_trips_pixi_packages() {
        let settings = SyncedSettings {
            color_theme: ColorTheme::Cream,
            pixi: PixiDefaults {
                default_packages: vec!["numpy".to_string(), "polars".to_string()],
            },
            ..SyncedSettings::default()
        };

        let doc = SettingsDoc::from_synced_settings(&settings);
        assert_eq!(doc.get_all(), settings);
    }

    #[test]
    #[serial(settings_sync_panic_hooks)]
    fn test_recovering_generate_sync_catches_injected_panic() {
        let _hook_guard = SettingsSyncFailureHookGuard::new();
        let mut doc = SettingsDoc::new();
        let mut peer_state = sync::State::new();

        SettingsDoc::__panic_on_next_generate_sync_calls_for_test(1);
        let error = doc
            .generate_sync_message_recovering("settings-test-generate", &mut peer_state)
            .expect_err("injected panic should be captured");

        assert_eq!(error.label, "settings-test-generate");
        assert!(error.panic_message.contains("generate sync"));
    }

    #[test]
    #[serial(settings_sync_panic_hooks)]
    fn test_recovering_receive_sync_catches_injected_panic() {
        let _hook_guard = SettingsSyncFailureHookGuard::new();
        let mut sender = SettingsDoc::new();
        sender.put("theme", "dark");
        let mut sender_state = sync::State::new();
        let message = sender
            .generate_sync_message(&mut sender_state)
            .expect("sender should generate sync message");

        let mut receiver = SettingsDoc::new();
        let mut receiver_state = sync::State::new();

        SettingsDoc::__panic_on_next_receive_sync_calls_for_test(1);
        let error = receiver
            .receive_sync_message_recovering("settings-test-receive", &mut receiver_state, message)
            .expect_err("injected panic should be captured");

        match error {
            AutomergeOperationError::Panic(error) => {
                assert_eq!(error.label, "settings-test-receive");
                assert!(error.panic_message.contains("receive sync"));
            }
            other => panic!("expected panic recovery error, got {other:?}"),
        }
    }

    #[test]
    fn test_put_u64_clamps_extreme_values() {
        let mut doc = SettingsDoc::new();

        // Very large value that would overflow i64
        let extreme_value = u64::MAX;
        doc.put_u64("keep_alive_secs", extreme_value);

        // Should be clamped to i64::MAX
        let result = doc.get_u64("keep_alive_secs");
        assert_eq!(result, Some(i64::MAX as u64));
    }

    #[test]
    fn test_is_null_returns_false_for_numeric() {
        let doc = SettingsDoc::new();
        // New doc has numeric keep_alive_secs (default 30)
        assert!(!doc.is_null("keep_alive_secs"));
    }

    #[test]
    fn test_is_null_returns_false_for_missing_key() {
        use automerge::AutoCommit;

        // Empty doc with no keep_alive_secs key
        let automerge_doc = AutoCommit::new();
        let doc = SettingsDoc { doc: automerge_doc };

        // Missing key is not the same as null
        assert!(!doc.is_null("keep_alive_secs"));
    }
}
