//! Populate `RuntimeStateDoc.project_context` on notebook open.
//!
//! The daemon is the sole writer of this field (see high-risk
//! architecture invariants: single-writer per shared CRDT key). This
//! module is the only place in the daemon that calls
//! `set_project_context`; clients read via the normal RuntimeState sync
//! path.
//!
//! Write triggers:
//!
//! - Room creation (`get_or_create_room` in `catalog.rs`).
//! - Untitled → file-backed promotion, after `finalize_untitled_promotion`
//!   stamps the new path.
//! - Save-as rename, after `save_notebook_to_disk` moves the file and
//!   `set_path` updates the room.
//!
//! - A filesystem watcher over every directory the detection walk
//!   visits (see [`daemon_project_file::project_watch_dirs`]), so edits,
//!   deletion, and creation of a closer or first manifest all refresh
//!   the context. Moving the notebook itself is still follow-up work.
//!
//! pyproject.toml goes through the `toml` crate; pixi.toml and
//! environment.yml still use line-scan for the handful of fields we
//! surface. We reach for real parsing when the format's grammar bites
//! back (PEP 508 extras like `requests[security,socks]>=2` contain
//! commas inside brackets, which a line scanner can't unambiguously
//! split).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use notify::Watcher;
use tokio::sync::oneshot;
use tracing::{error, warn};

use runtime_doc::{
    ProjectContext, ProjectFile, ProjectFileExtras, ProjectFileKind, ProjectFileParsed,
};

use crate::project_file::{self as daemon_project_file, DetectedProjectFile};

use super::room::NotebookRoom;
use crate::task_supervisor::spawn_best_effort;

/// Serializes ownership changes with publication, without holding a lock across
/// watcher setup or an await. Old callbacks may finish IO, but cannot publish.
#[derive(Default)]
pub(super) struct ProjectFileWatcher {
    current: std::sync::Mutex<WatchState>,
    #[cfg(test)]
    pub(super) before_subscribe: std::sync::Mutex<Option<Box<dyn FnOnce() + Send>>>,
}

#[derive(Default)]
struct WatchState {
    registration: Option<WatchRegistration>,
    stopped: bool,
}

struct WatchRegistration {
    generation: Arc<()>,
    shutdown: oneshot::Sender<()>,
}

impl ProjectFileWatcher {
    pub(super) fn start(&self) -> Option<(Arc<()>, oneshot::Receiver<()>)> {
        let (shutdown, receiver) = oneshot::channel();
        let generation = Arc::new(());
        let mut current = self.current.lock().unwrap_or_else(|e| e.into_inner());
        if current.stopped {
            return None;
        }
        if let Some(previous) = current.registration.replace(WatchRegistration {
            generation: generation.clone(),
            shutdown,
        }) {
            let _ = previous.shutdown.send(());
        }
        Some((generation, receiver))
    }

    pub(super) fn shutdown(&self) -> bool {
        let mut current = self.current.lock().unwrap_or_else(|e| e.into_inner());
        // Only explicit room teardown calls shutdown; refresh uses start.
        // Fence continuations that have not reached registration yet.
        current.stopped = true;
        if let Some(previous) = current.registration.take() {
            let _ = previous.shutdown.send(());
            true
        } else {
            false
        }
    }

    fn if_current<T>(&self, generation: &Arc<()>, f: impl FnOnce() -> T) -> Option<T> {
        let current = self.current.lock().unwrap_or_else(|e| e.into_inner());
        current
            .registration
            .as_ref()
            .filter(|entry| Arc::ptr_eq(&entry.generation, generation))
            .map(|_| f())
    }

    fn finish(&self, generation: &Arc<()>) {
        let mut current = self.current.lock().unwrap_or_else(|e| e.into_inner());
        if current
            .registration
            .as_ref()
            .is_some_and(|entry| Arc::ptr_eq(&entry.generation, generation))
        {
            current.registration.take();
        }
    }

    #[cfg(test)]
    pub(super) fn is_active(&self) -> bool {
        self.current.lock().unwrap().registration.is_some()
    }
}

/// Replace the watcher using the current bound notebook path, falling back to
/// `path` only for an untitled room. A stale caller cannot restore an old path. Normal
/// manifest events stay in that task and retain its subscription/debounce queue.
/// Readiness includes a fresh scan after subscriptions are installed, so changes
/// during setup cannot leave a stale snapshot waiting for another event.
pub(super) async fn refresh_project_context_async(room: &Arc<NotebookRoom>, path: Option<&Path>) {
    let Some(anchor) = path else {
        return;
    };
    let Some((anchor, generation, shutdown_rx)) =
        room.file_binding.start_project_file_watcher(anchor).await
    else {
        return;
    };
    let (ready_tx, ready_rx) = oneshot::channel();
    let room = room.clone();
    spawn_best_effort("project-file-watcher", async move {
        run_project_file_watcher(&room, &anchor, &generation, shutdown_rx, ready_tx).await;
        room.file_binding.project_file_watcher.finish(&generation);
    });
    let _ = ready_rx.await;
}

async fn publish_context(
    room: &NotebookRoom,
    anchor: &Path,
    generation: &Arc<()>,
    ctx: &ProjectContext,
) -> bool {
    room.file_binding
        .with_project_file_anchor(anchor, || {
            room.file_binding
                .project_file_watcher
                .if_current(generation, || {
                    if let Err(error) = room.state.with_doc(|sd| sd.set_project_context(ctx)) {
                        warn!("[project-watch] Failed to write project_context: {error}");
                    }
                })
                .is_some()
        })
        .await
        .unwrap_or(false)
}

/// Directory watches cover new manifests and atomic temp-file/rename saves.
/// Updating notify subscriptions can restart its macOS event stream. Always
/// scan *after* changing coverage; ordinary events need no subscription churn.
fn update_watch_dirs(
    watcher: &mut dyn notify::Watcher,
    watched: &mut Vec<PathBuf>,
    desired: &[PathBuf],
    invalidated: WatchInvalidations,
) {
    watched.retain(|dir| {
        if invalidated.all || invalidated.paths.iter().any(|path| dir.starts_with(path)) {
            // DELETE_SELF can already have removed the backend watch.
            let _ = watcher.unwatch(dir);
            false
        } else {
            true
        }
    });
    for dir in desired {
        if !watched.contains(dir) {
            match watcher.watch(dir, notify::RecursiveMode::NonRecursive) {
                Ok(()) => watched.push(dir.clone()),
                Err(error) => {
                    warn!("[project-watch] Failed to add project directory watch: {error}")
                }
            }
        }
    }
    watched.retain(|dir| {
        if desired.contains(dir) {
            return true;
        }
        match watcher.unwatch(dir) {
            Ok(()) => false,
            Err(error) => {
                warn!("[project-watch] Failed to remove project directory watch: {error}");
                true
            }
        }
    });
}

#[derive(Default)]
struct WatchInvalidations {
    all: bool,
    paths: std::collections::HashSet<PathBuf>,
}

impl WatchInvalidations {
    fn record(&mut self, event: &notify::Event) {
        // Overflow can hide DELETE_SELF, so pathname bookkeeping is no longer
        // evidence that any backend subscription is still live.
        self.all |= event.need_rescan();
        if matches!(
            event.kind,
            notify::EventKind::Remove(notify::event::RemoveKind::Folder)
                | notify::EventKind::Modify(notify::event::ModifyKind::Name(_))
        ) {
            self.paths.extend(event.paths.iter().cloned());
        }
    }
}

async fn run_project_file_watcher(
    room: &NotebookRoom,
    anchor: &Path,
    generation: &Arc<()>,
    mut shutdown_rx: oneshot::Receiver<()>,
    ready_tx: oneshot::Sender<()>,
) {
    // A single queued trigger is enough: each pass reads current filesystem
    // state. Never block notify's OS thread while dropping/reconfiguring it.
    let (changed_tx, mut changed_rx) = tokio::sync::mpsc::channel(1);
    // Unlike refresh triggers, lifecycle invalidations cannot be coalesced away:
    // notify may have dropped a subscription while its pathname stayed desired.
    let invalidated = Arc::new(std::sync::Mutex::new(WatchInvalidations::default()));
    let callback_invalidated = invalidated.clone();
    let mut watcher = match notify::RecommendedWatcher::new(
        move |result: notify::Result<notify::Event>| {
            let relevant = match result {
                Ok(event) => {
                    callback_invalidated
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .record(&event);
                    relevant_project_event(&event)
                }
                Err(error) => {
                    warn!("[project-watch] Watcher error: {error}");
                    true
                }
            };
            if relevant {
                let _ = changed_tx.try_send(());
            }
        },
        notify::Config::default(),
    ) {
        Ok(watcher) => watcher,
        Err(error) => {
            error!("[project-watch] Failed to create watcher: {error}");
            publish_context(room, anchor, generation, &build_context(anchor)).await;
            return;
        }
    };

    let mut watched: Vec<PathBuf> = Vec::new();
    let mut ready = Some(ready_tx);
    loop {
        if room
            .file_binding
            .project_file_watcher
            .if_current(generation, || ())
            .is_none()
        {
            return;
        }
        let desired = daemon_project_file::project_watch_dirs(anchor);
        #[cfg(test)]
        {
            let hook = room
                .file_binding
                .project_file_watcher
                .before_subscribe
                .lock()
                .unwrap()
                .take();
            if let Some(hook) = hook {
                hook();
            }
        }
        let removed = {
            let mut invalidated = invalidated.lock().unwrap_or_else(|e| e.into_inner());
            std::mem::take(&mut *invalidated)
        };
        update_watch_dirs(&mut watcher, &mut watched, &desired, removed);
        let ctx = build_context(anchor);
        // The manifest boundary can itself change during subscription setup.
        // Expand/shrink coverage and rescan before advertising readiness.
        if daemon_project_file::project_watch_dirs(anchor) != desired {
            tokio::task::yield_now().await;
            continue;
        }
        if !publish_context(room, anchor, generation, &ctx).await {
            return;
        }
        if let Some(ready_tx) = ready.take() {
            let _ = ready_tx.send(());
        }
        let missing_directory = desired.iter().any(|dir| !watched.contains(dir));
        if watched.is_empty() && !missing_directory {
            return;
        }
        tokio::select! {
            biased;
            _ = &mut shutdown_rx => return,
            event = changed_rx.recv() => if event.is_none() { return; },
            // No subscription can report recreation when every desired path
            // is absent. Retry coverage without restarting healthy watches.
            _ = tokio::time::sleep(std::time::Duration::from_millis(500)),
                if missing_directory => continue,
        }
        // Bound refresh rate during write bursts, while keeping shutdown prompt.
        tokio::select! {
            biased;
            _ = &mut shutdown_rx => return,
            _ = tokio::time::sleep(std::time::Duration::from_millis(500)) => {},
        }
        // Mutations up to this point are covered by the next scan. A mutation
        // during/after that scan queues a fresh trigger for another pass.
        while changed_rx.try_recv().is_ok() {}
    }
}

/// Access notifications from our own reads must not feed another refresh.
/// Keep close-after-write and backend overflow/rescan signals.
fn relevant_project_event(event: &notify::Event) -> bool {
    use notify::event::{AccessKind, AccessMode};
    if event.need_rescan() {
        return true;
    }
    if matches!(event.kind, notify::EventKind::Access(kind)
        if kind != AccessKind::Close(AccessMode::Write))
    {
        return false;
    }
    if matches!(
        event.kind,
        notify::EventKind::Create(notify::event::CreateKind::Folder)
            | notify::EventKind::Remove(notify::event::RemoveKind::Folder)
            | notify::EventKind::Modify(notify::event::ModifyKind::Name(_))
    ) {
        return true;
    }
    event.paths.iter().any(|path| {
        path.file_name()
            .is_some_and(daemon_project_file::is_project_file_name)
    })
}

/// Detect + parse, translating the daemon's internal `DetectedProjectFile`
/// into the `ProjectContext` shape consumers read.
fn build_context(notebook_path: &Path) -> ProjectContext {
    let observed_at = current_iso_timestamp();

    let Some(detected) = daemon_project_file::detect_project_file(notebook_path) else {
        return ProjectContext::NotFound { observed_at };
    };

    let kind = translate_kind(&detected.kind);
    let relative_to_notebook = relative_to_notebook(notebook_path, &detected.path);

    let content = match std::fs::read_to_string(&detected.path) {
        Ok(s) => s,
        Err(e) => {
            return ProjectContext::Unreadable {
                path: detected.path.to_string_lossy().into_owned(),
                reason: format!("read failed: {e}"),
                observed_at,
            };
        }
    };

    match parse_detected(&detected, &content) {
        Ok(parsed) => ProjectContext::Detected {
            project_file: ProjectFile {
                kind,
                absolute_path: detected.path.to_string_lossy().into_owned(),
                relative_to_notebook,
            },
            parsed,
            observed_at,
        },
        Err(reason) => ProjectContext::Unreadable {
            path: detected.path.to_string_lossy().into_owned(),
            reason,
            observed_at,
        },
    }
}

fn translate_kind(kind: &daemon_project_file::ProjectFileKind) -> ProjectFileKind {
    match kind {
        daemon_project_file::ProjectFileKind::PyprojectToml => ProjectFileKind::PyprojectToml,
        daemon_project_file::ProjectFileKind::PixiToml => ProjectFileKind::PixiToml,
        daemon_project_file::ProjectFileKind::EnvironmentYml => ProjectFileKind::EnvironmentYml,
    }
}

/// Best-effort relative path from the notebook's parent to the project
/// file. Falls back to the absolute path when a common ancestor can't
/// be cheaply derived. Purely display-oriented; consumers compare by
/// kind and absolute_path, not by this.
fn relative_to_notebook(notebook_path: &Path, project_file: &Path) -> String {
    let notebook_dir = if notebook_path.is_dir() {
        notebook_path
    } else {
        notebook_path.parent().unwrap_or(notebook_path)
    };
    // For the common case (notebook's directory contains or is the
    // ancestor of the project file), strip_prefix is all we need.
    if let Ok(rel) = project_file.strip_prefix(notebook_dir) {
        return rel.to_string_lossy().into_owned();
    }
    // Walk up from notebook_dir counting ".." hops until we hit an
    // ancestor that's also an ancestor of the project file.
    let mut hops = 0usize;
    let mut current = notebook_dir;
    loop {
        if let Ok(rel) = project_file.strip_prefix(current) {
            let mut out = String::new();
            for _ in 0..hops {
                out.push_str("../");
            }
            out.push_str(&rel.to_string_lossy());
            return out;
        }
        match current.parent() {
            Some(parent) if parent != current => {
                current = parent;
                hops += 1;
            }
            _ => break,
        }
    }
    project_file.to_string_lossy().into_owned()
}

fn parse_detected(
    detected: &DetectedProjectFile,
    content: &str,
) -> Result<ProjectFileParsed, String> {
    match detected.kind {
        daemon_project_file::ProjectFileKind::PyprojectToml => parse_pyproject_toml(content),
        daemon_project_file::ProjectFileKind::PixiToml => Ok(parse_pixi_toml(content)),
        daemon_project_file::ProjectFileKind::EnvironmentYml => {
            parse_environment_yml(&detected.path, content)
        }
    }
}

/// pyproject.toml: extract `[project].dependencies`,
/// `[project].requires-python`, `[tool.uv].dev-dependencies`, and
/// `[dependency-groups].dev`.
///
/// Uses real TOML parsing via `serde`. PEP 508 specs such as
/// `requests[security,socks]>=2` include commas inside bracket groups,
/// which a line scanner couldn't distinguish from list separators.
///
/// Parse errors — both raw-TOML syntax failures and schema-valid but
/// shape-invalid inputs (`dependencies = "pandas"` where a list is
/// expected) — route to `Err(reason)` so `build_context` emits
/// `ProjectContext::Unreadable` and the UI surfaces the problem instead
/// of silently reporting zero deps.
fn parse_pyproject_toml(content: &str) -> Result<ProjectFileParsed, String> {
    #[derive(serde::Deserialize, Default)]
    struct Root {
        #[serde(default)]
        project: ProjectTable,
        #[serde(default)]
        tool: ToolTable,
        #[serde(rename = "dependency-groups", default)]
        dependency_groups: DependencyGroups,
    }

    #[derive(serde::Deserialize, Default)]
    struct ProjectTable {
        #[serde(default)]
        dependencies: Vec<String>,
        #[serde(rename = "requires-python", default)]
        requires_python: Option<String>,
    }

    #[derive(serde::Deserialize, Default)]
    struct ToolTable {
        #[serde(default)]
        uv: ToolUv,
    }

    #[derive(serde::Deserialize, Default)]
    struct ToolUv {
        #[serde(rename = "dev-dependencies", default)]
        dev_dependencies: Vec<String>,
    }

    #[derive(serde::Deserialize, Default)]
    struct DependencyGroups {
        #[serde(default)]
        dev: Vec<DependencyGroupEntry>,
    }

    #[derive(serde::Deserialize)]
    #[serde(untagged)]
    enum DependencyGroupEntry {
        Spec(String),
        Other(toml::Value),
    }

    impl DependencyGroupEntry {
        fn into_spec(self) -> Option<String> {
            match self {
                Self::Spec(spec) => Some(spec),
                Self::Other(value) => {
                    let _ = value;
                    None
                }
            }
        }
    }

    let root: Root =
        toml::from_str(content).map_err(|e| format!("pyproject.toml parse failed: {e}"))?;
    let mut dev_dependencies = root.tool.uv.dev_dependencies;
    for spec in root
        .dependency_groups
        .dev
        .into_iter()
        .filter_map(DependencyGroupEntry::into_spec)
    {
        if !dev_dependencies.contains(&spec) {
            dev_dependencies.push(spec);
        }
    }
    Ok(ProjectFileParsed {
        dependencies: root.project.dependencies,
        dev_dependencies,
        requires_python: root.project.requires_python,
        prerelease: None,
        extras: ProjectFileExtras::None,
    })
}

/// Commit-2 pixi parsing keeps the easy signals: channels (top-level
/// array) and the list of dep keys under `[dependencies]`/
/// `[pypi-dependencies]`. Structured values like `{ version = "^13" }`
/// are represented by the bare package name for now; commit 3 can
/// enrich with proper TOML parsing if we find consumers that need the
/// version specifiers.
fn parse_pixi_toml(content: &str) -> ProjectFileParsed {
    let mut current_table = String::new();
    let mut channels: Vec<String> = Vec::new();
    let mut deps: Vec<String> = Vec::new();
    let mut pypi: Vec<String> = Vec::new();
    let mut in_channels_array = false;

    for line in content.lines() {
        let trimmed = line.trim();

        if in_channels_array {
            // collect entries until closing `]`
            if trimmed.starts_with(']') {
                in_channels_array = false;
                continue;
            }
            if let Some(entry) = extract_quoted_entry(trimmed) {
                channels.push(entry);
            }
            continue;
        }

        if let Some(header) = trimmed.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
            current_table = header.to_string();
            continue;
        }

        // Top-level `channels = [...]` applies under pixi's `[project]`
        // or `[tool.pixi.project]` tables. Pick it up wherever it lands.
        if trimmed.starts_with("channels") && trimmed.contains('=') {
            if let Some((_, rest)) = trimmed.split_once('=') {
                let rest = rest.trim();
                if rest.starts_with('[') {
                    if let Some(inner) = rest.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
                        push_string_entries(inner, &mut channels);
                    } else {
                        in_channels_array = true;
                    }
                }
            }
            continue;
        }

        // Dep-table entries: `name = "spec"` or `name = { ... }`. Commit
        // 2 surfaces the key only.
        let is_dep_table = current_table == "dependencies"
            || current_table == "tool.pixi.dependencies"
            || current_table == "pypi-dependencies"
            || current_table == "tool.pixi.pypi-dependencies";
        if is_dep_table {
            if let Some(key) = trimmed.split('=').next() {
                let key = key.trim();
                if !key.is_empty() && !key.starts_with('#') {
                    if current_table.ends_with("pypi-dependencies") {
                        pypi.push(key.to_string());
                    } else {
                        deps.push(key.to_string());
                    }
                }
            }
        }
    }

    deps.sort();
    pypi.sort();

    ProjectFileParsed {
        dependencies: deps,
        dev_dependencies: Vec::new(),
        requires_python: None,
        prerelease: None,
        extras: ProjectFileExtras::Pixi {
            channels,
            pypi_dependencies: pypi,
        },
    }
}

/// environment.yml parses via the daemon's existing rattler-backed
/// parser for deps/python. When that parse fails the file is genuinely
/// unreadable (bad YAML, bad conda spec); route the caller to
/// `ProjectContext::Unreadable` instead of emitting an empty `Detected`
/// that hides the problem.
fn parse_environment_yml(path: &Path, content: &str) -> Result<ProjectFileParsed, String> {
    let config = daemon_project_file::parse_environment_yml(path)?;
    let pip = extract_environment_yml_pip(content);

    Ok(ProjectFileParsed {
        dependencies: config.dependencies,
        dev_dependencies: Vec::new(),
        requires_python: config.python,
        prerelease: None,
        extras: ProjectFileExtras::EnvironmentYml {
            channels: config.channels,
            pip,
            name: config.name,
            prefix: config.prefix.map(|p| p.to_string_lossy().into_owned()),
        },
    })
}

/// Line-scan for `  - pip:` followed by its nested `    - foo` entries.
/// Tracks indentation of the `pip:` marker to know when the block ends.
fn extract_environment_yml_pip(content: &str) -> Vec<String> {
    let mut pip: Vec<String> = Vec::new();
    let mut pip_indent: Option<usize> = None;

    for line in content.lines() {
        let indent = line.len() - line.trim_start().len();
        let trimmed = line.trim();

        if pip_indent.is_some() {
            if trimmed.is_empty() {
                continue;
            }
            // A line whose indent is <= the `pip:` marker ends the block.
            if indent <= pip_indent.unwrap_or(usize::MAX) {
                pip_indent = None;
            } else if let Some(rest) = trimmed.strip_prefix("- ") {
                let entry = rest.trim().trim_matches('"').trim_matches('\'').trim();
                if !entry.is_empty() {
                    pip.push(entry.to_string());
                }
                continue;
            }
        }

        if trimmed == "- pip:" {
            pip_indent = Some(indent);
        }
    }

    pip
}

fn extract_quoted_entry(line: &str) -> Option<String> {
    let trimmed = line.trim().trim_end_matches(',').trim();
    let (quote, rest) = if let Some(rest) = trimmed.strip_prefix('"') {
        ('"', rest)
    } else {
        ('\'', trimmed.strip_prefix('\'')?)
    };
    let end = rest.find(quote)?;
    Some(rest[..end].to_string())
}

fn push_string_entries(inner: &str, dest: &mut Vec<String>) {
    for raw in inner.split(',') {
        if let Some(entry) = extract_quoted_entry(raw) {
            if !entry.is_empty() {
                dest.push(entry);
            }
        }
    }
}

fn current_iso_timestamp() -> String {
    chrono::Utc::now().to_rfc3339()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use tempfile::TempDir;

    #[test]
    fn project_events_ignore_reads_but_keep_writes_and_rescans() {
        use notify::event::{
            AccessKind, AccessMode, CreateKind, DataChange, Flag, ModifyKind, RemoveKind,
            RenameMode,
        };
        use notify::{Event, EventKind};
        for kind in [
            AccessKind::Read,
            AccessKind::Open(AccessMode::Read),
            AccessKind::Open(AccessMode::Write),
            AccessKind::Close(AccessMode::Read),
        ] {
            assert!(!relevant_project_event(
                &Event::new(EventKind::Access(kind)).add_path("environment.yml".into())
            ));
        }
        for kind in [
            EventKind::Create(CreateKind::File),
            EventKind::Modify(ModifyKind::Data(DataChange::Any)),
            EventKind::Modify(ModifyKind::Name(RenameMode::Both)),
            EventKind::Remove(RemoveKind::File),
            EventKind::Access(AccessKind::Close(AccessMode::Write)),
        ] {
            assert!(relevant_project_event(
                &Event::new(kind).add_path("environment.yml".into())
            ));
        }
        assert!(!relevant_project_event(
            &Event::new(EventKind::Any).add_path("unrelated.txt".into())
        ));
        assert!(relevant_project_event(
            &Event::new(EventKind::Other).set_flag(Flag::Rescan)
        ));
        for kind in [
            EventKind::Create(CreateKind::Folder),
            EventKind::Remove(RemoveKind::Folder),
            EventKind::Modify(ModifyKind::Name(RenameMode::From)),
        ] {
            assert!(relevant_project_event(
                &Event::new(kind).add_path("analysis".into())
            ));
        }
    }

    fn write(dir: &Path, name: &str, body: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, body).unwrap();
        path
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn pathless_rescan_rearms_lost_subscription() {
        use notify::event::Flag;
        let temp = TempDir::new().unwrap();
        let desired = vec![temp.path().to_path_buf()];
        let (tx, rx) = std::sync::mpsc::channel();
        let mut watcher =
            notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                if let Ok(event) = event {
                    if relevant_project_event(&event) {
                        let _ = tx.send(());
                    }
                }
            })
            .unwrap();
        let mut watched = Vec::new();
        update_watch_dirs(
            &mut watcher,
            &mut watched,
            &desired,
            WatchInvalidations::default(),
        );
        // Simulate a kernel subscription lost without its lifecycle callback.
        watcher.unwatch(temp.path()).unwrap();
        let mut invalidated = WatchInvalidations::default();
        invalidated.record(&notify::Event::new(notify::EventKind::Other).set_flag(Flag::Rescan));
        update_watch_dirs(&mut watcher, &mut watched, &desired, invalidated);
        let manifest = write(
            temp.path(),
            "environment.yml",
            "dependencies:\n  - pandas\n",
        );
        rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
        // Wait for the first write's notifications to settle without changing
        // coverage, then require another event from the repaired subscription.
        while rx
            .recv_timeout(std::time::Duration::from_millis(100))
            .is_ok()
        {}
        std::fs::write(manifest, "dependencies:\n  - scipy\n").unwrap();
        rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
    }

    #[test]
    fn build_context_on_empty_tempdir_returns_not_found() {
        let temp = TempDir::new().unwrap();
        let notebook = write(temp.path(), "untitled.ipynb", "{}");
        let ctx = build_context(&notebook);
        assert!(matches!(ctx, ProjectContext::NotFound { .. }));
    }

    #[test]
    fn build_context_pyproject_extracts_deps_and_python() {
        let temp = TempDir::new().unwrap();
        write(
            temp.path(),
            "pyproject.toml",
            "[project]\nname = \"demo\"\ndependencies = [\"pandas>=2.0\", \"numpy\"]\nrequires-python = \">=3.11\"\n",
        );
        let notebook = write(temp.path(), "demo.ipynb", "{}");

        let ctx = build_context(&notebook);
        let ProjectContext::Detected {
            project_file,
            parsed,
            ..
        } = ctx
        else {
            panic!("expected Detected");
        };
        assert_eq!(project_file.kind, ProjectFileKind::PyprojectToml);
        assert_eq!(parsed.dependencies, vec!["pandas>=2.0", "numpy"]);
        assert_eq!(parsed.requires_python.as_deref(), Some(">=3.11"));
        assert_eq!(parsed.extras, ProjectFileExtras::None);
    }

    #[test]
    fn build_context_pyproject_preserves_pep508_extras() {
        // PEP 508 specs can nest brackets with commas. A line-scan
        // parser used to split "requests[security,socks]>=2" into two
        // pieces on the inner comma. The toml-backed parser keeps the
        // spec verbatim.
        let temp = TempDir::new().unwrap();
        write(
            temp.path(),
            "pyproject.toml",
            "[project]\nname = \"demo\"\ndependencies = [\n    \"requests[security,socks]>=2\",\n    \"httpx[http2]>=0.27\",\n    \"numpy\",\n]\n",
        );
        let notebook = write(temp.path(), "demo.ipynb", "{}");

        let ctx = build_context(&notebook);
        let ProjectContext::Detected { parsed, .. } = ctx else {
            panic!("expected Detected");
        };
        assert_eq!(
            parsed.dependencies,
            vec![
                "requests[security,socks]>=2".to_string(),
                "httpx[http2]>=0.27".to_string(),
                "numpy".to_string(),
            ]
        );
    }

    #[test]
    fn build_context_pyproject_preserves_env_marker_specs() {
        // Environment markers — "; python_version < '3.11'" — must
        // survive intact. Line-scanning used to truncate at the
        // semicolon under some multi-line formatters.
        let temp = TempDir::new().unwrap();
        write(
            temp.path(),
            "pyproject.toml",
            "[project]\nname = \"demo\"\ndependencies = [\n    \"tomli ; python_version < '3.11'\",\n]\n",
        );
        let notebook = write(temp.path(), "demo.ipynb", "{}");

        let ctx = build_context(&notebook);
        let ProjectContext::Detected { parsed, .. } = ctx else {
            panic!("expected Detected");
        };
        assert_eq!(
            parsed.dependencies,
            vec!["tomli ; python_version < '3.11'".to_string()]
        );
    }

    #[test]
    fn build_context_pyproject_multiline_deps() {
        let temp = TempDir::new().unwrap();
        write(
            temp.path(),
            "pyproject.toml",
            "[project]\nname = \"demo\"\ndependencies = [\n    \"pandas>=2.0\",\n    \"numpy\",\n]\n",
        );
        let notebook = write(temp.path(), "demo.ipynb", "{}");

        let ctx = build_context(&notebook);
        let ProjectContext::Detected { parsed, .. } = ctx else {
            panic!("expected Detected");
        };
        assert_eq!(parsed.dependencies, vec!["pandas>=2.0", "numpy"]);
    }

    #[test]
    fn build_context_pyproject_from_directory_anchor() {
        let temp = TempDir::new().unwrap();
        write(
            temp.path(),
            "pyproject.toml",
            "[project]\nname = \"demo\"\ndependencies = [\"pandas\"]\n",
        );

        let ctx = build_context(temp.path());
        let ProjectContext::Detected {
            project_file,
            parsed,
            ..
        } = ctx
        else {
            panic!("expected Detected");
        };
        assert_eq!(project_file.kind, ProjectFileKind::PyprojectToml);
        assert_eq!(project_file.relative_to_notebook, "pyproject.toml");
        assert_eq!(parsed.dependencies, vec!["pandas"]);
    }

    #[test]
    fn build_context_pyproject_captures_tool_uv_dev_dependencies() {
        let temp = TempDir::new().unwrap();
        write(
            temp.path(),
            "pyproject.toml",
            "[project]\nname = \"demo\"\ndependencies = [\"pandas\"]\n\n[tool.uv]\ndev-dependencies = [\"pytest\", \"ruff>=0.6\"]\n",
        );
        let notebook = write(temp.path(), "demo.ipynb", "{}");

        let ctx = build_context(&notebook);
        let ProjectContext::Detected { parsed, .. } = ctx else {
            panic!("expected Detected");
        };
        assert_eq!(parsed.dependencies, vec!["pandas"]);
        assert_eq!(parsed.dev_dependencies, vec!["pytest", "ruff>=0.6"]);
    }

    #[test]
    fn build_context_pyproject_captures_dependency_groups_dev() {
        let temp = TempDir::new().unwrap();
        write(
            temp.path(),
            "pyproject.toml",
            "[project]\nname = \"demo\"\ndependencies = [\"pandas\"]\n\n[dependency-groups]\ndev = [\"matplotlib>=3\", \"plotly\"]\n",
        );
        let notebook = write(temp.path(), "demo.ipynb", "{}");

        let ctx = build_context(&notebook);
        let ProjectContext::Detected { parsed, .. } = ctx else {
            panic!("expected Detected");
        };
        assert_eq!(parsed.dependencies, vec!["pandas"]);
        assert_eq!(parsed.dev_dependencies, vec!["matplotlib>=3", "plotly"]);
    }

    #[test]
    fn build_context_pyproject_merges_legacy_and_current_dev_deps() {
        let temp = TempDir::new().unwrap();
        write(
            temp.path(),
            "pyproject.toml",
            "[project]\nname = \"demo\"\ndependencies = [\"pandas\"]\n\n[tool.uv]\ndev-dependencies = [\"pytest\", \"plotly\"]\n\n[dependency-groups]\ndev = [\"plotly\", \"altair\"]\n",
        );
        let notebook = write(temp.path(), "demo.ipynb", "{}");

        let ctx = build_context(&notebook);
        let ProjectContext::Detected { parsed, .. } = ctx else {
            panic!("expected Detected");
        };
        assert_eq!(parsed.dependencies, vec!["pandas"]);
        assert_eq!(parsed.dev_dependencies, vec!["pytest", "plotly", "altair"]);
    }

    #[test]
    fn build_context_pyproject_schema_mismatch_routes_to_unreadable() {
        // Well-formed TOML, wrong shape: `dependencies` should be a
        // list of strings, not a bare string. The prior fallback
        // silently reported zero deps — now it surfaces as Unreadable
        // so the UI can explain what's wrong.
        let temp = TempDir::new().unwrap();
        write(
            temp.path(),
            "pyproject.toml",
            "[project]\nname = \"demo\"\ndependencies = \"pandas\"\n",
        );
        let notebook = write(temp.path(), "demo.ipynb", "{}");

        let ctx = build_context(&notebook);
        let ProjectContext::Unreadable { path, reason, .. } = ctx else {
            panic!("expected Unreadable, got {ctx:?}");
        };
        assert!(path.ends_with("pyproject.toml"));
        assert!(reason.contains("parse failed"));
    }

    #[test]
    fn build_context_pyproject_empty_dev_deps_when_tool_uv_absent() {
        // Plain [project] pyproject with no [tool.uv] block. Not having
        // dev-dependencies shouldn't leak values from a prior state; it
        // should be an empty vec.
        let temp = TempDir::new().unwrap();
        write(
            temp.path(),
            "pyproject.toml",
            "[project]\nname = \"demo\"\ndependencies = [\"pandas\"]\n",
        );
        let notebook = write(temp.path(), "demo.ipynb", "{}");

        let ctx = build_context(&notebook);
        let ProjectContext::Detected { parsed, .. } = ctx else {
            panic!("expected Detected");
        };
        assert!(parsed.dev_dependencies.is_empty());
    }

    #[test]
    fn build_context_pixi_collects_channels_and_pypi_keys() {
        let temp = TempDir::new().unwrap();
        write(
            temp.path(),
            "pixi.toml",
            "[project]\nname = \"demo\"\nchannels = [\"conda-forge\", \"bioconda\"]\n\n[dependencies]\npython = \"3.11.*\"\nnumpy = \"*\"\n\n[pypi-dependencies]\nrequests = \"*\"\nrich = { version = \"^13\" }\n",
        );
        let notebook = write(temp.path(), "demo.ipynb", "{}");

        let ctx = build_context(&notebook);
        let ProjectContext::Detected {
            project_file,
            parsed,
            ..
        } = ctx
        else {
            panic!("expected Detected");
        };
        assert_eq!(project_file.kind, ProjectFileKind::PixiToml);
        assert!(parsed.dependencies.iter().any(|d| d == "numpy"));
        assert!(parsed.dependencies.iter().any(|d| d == "python"));
        let ProjectFileExtras::Pixi {
            channels,
            pypi_dependencies,
        } = parsed.extras
        else {
            panic!("expected Pixi extras");
        };
        assert_eq!(channels, vec!["conda-forge", "bioconda"]);
        assert!(pypi_dependencies.iter().any(|d| d == "requests"));
        assert!(pypi_dependencies.iter().any(|d| d == "rich"));
    }

    #[test]
    fn build_context_environment_yml_pulls_pip_sublist() {
        let temp = TempDir::new().unwrap();
        write(
            temp.path(),
            "environment.yml",
            "name: demo\nchannels:\n  - conda-forge\ndependencies:\n  - python=3.11\n  - numpy\n  - pip:\n    - requests\n    - flask\n",
        );
        let notebook = write(temp.path(), "demo.ipynb", "{}");

        let ctx = build_context(&notebook);
        let ProjectContext::Detected {
            project_file,
            parsed,
            ..
        } = ctx
        else {
            panic!("expected Detected");
        };
        assert_eq!(project_file.kind, ProjectFileKind::EnvironmentYml);
        assert!(parsed.dependencies.iter().any(|d| d == "numpy"));
        // rattler normalizes `python=3.11` → `"3.11.*"`
        assert_eq!(parsed.requires_python.as_deref(), Some("3.11.*"));
        let ProjectFileExtras::EnvironmentYml {
            channels,
            pip,
            name,
            prefix,
        } = parsed.extras
        else {
            panic!("expected EnvironmentYml extras");
        };
        assert_eq!(channels, vec!["conda-forge".to_string()]);
        assert_eq!(pip, vec!["requests".to_string(), "flask".to_string()]);
        assert_eq!(name.as_deref(), Some("demo"));
        assert_eq!(prefix, None);
    }

    #[test]
    fn build_context_environment_yml_surfaces_explicit_prefix() {
        let temp = TempDir::new().unwrap();
        write(
            temp.path(),
            "environment.yml",
            "prefix: /opt/envs/my env\ndependencies:\n  - python=3.11\n",
        );
        let notebook = write(temp.path(), "demo.ipynb", "{}");

        let ctx = build_context(&notebook);
        let ProjectContext::Detected { parsed, .. } = ctx else {
            panic!("expected Detected");
        };
        let ProjectFileExtras::EnvironmentYml { name, prefix, .. } = parsed.extras else {
            panic!("expected EnvironmentYml extras");
        };
        assert_eq!(name, None);
        assert_eq!(prefix.as_deref(), Some("/opt/envs/my env"));
    }

    #[test]
    fn build_context_malformed_environment_yml_returns_unreadable() {
        let temp = TempDir::new().unwrap();
        // Invalid YAML — the rattler parser rejects it.
        write(
            temp.path(),
            "environment.yml",
            "name: demo\ndependencies: { this is not valid yaml\n",
        );
        let notebook = write(temp.path(), "demo.ipynb", "{}");

        let ctx = build_context(&notebook);
        let ProjectContext::Unreadable { path, reason, .. } = ctx else {
            panic!("expected Unreadable, got {ctx:?}");
        };
        assert!(path.ends_with("environment.yml"));
        assert!(!reason.is_empty());
    }

    #[test]
    fn build_context_unreadable_on_read_error() {
        // Create a pyproject.toml as a directory instead of a file to
        // force a read failure. Real cases (permissions, vanished file)
        // hit the same Err arm.
        let temp = TempDir::new().unwrap();
        std::fs::create_dir(temp.path().join("pyproject.toml")).unwrap();
        let notebook = write(temp.path(), "demo.ipynb", "{}");

        let ctx = build_context(&notebook);
        let ProjectContext::Unreadable { path, reason, .. } = ctx else {
            panic!("expected Unreadable, got {ctx:?}");
        };
        assert!(path.ends_with("pyproject.toml"));
        assert!(reason.contains("read failed"));
    }

    #[test]
    fn relative_to_notebook_handles_sibling_and_parent() {
        assert_eq!(
            relative_to_notebook(
                Path::new("/foo/bar/demo.ipynb"),
                Path::new("/foo/bar/pyproject.toml"),
            ),
            "pyproject.toml"
        );
        assert_eq!(
            relative_to_notebook(
                Path::new("/foo/bar/demo.ipynb"),
                Path::new("/foo/pyproject.toml"),
            ),
            "../pyproject.toml"
        );
        let temp = TempDir::new().unwrap();
        assert_eq!(
            relative_to_notebook(temp.path(), &temp.path().join("pyproject.toml")),
            "pyproject.toml"
        );
    }

    #[test]
    fn build_context_reflects_new_location_on_rerun() {
        // Locks in the "re-runnable on path change" promise in
        // refresh_project_context's doc comment. Building against
        // location A then rebuilding against location B must produce
        // B's answer, not a merge of both.
        let temp = TempDir::new().unwrap();
        let with_pyproject = temp.path().join("with");
        let bare = temp.path().join("bare");
        std::fs::create_dir_all(&with_pyproject).unwrap();
        std::fs::create_dir_all(&bare).unwrap();
        write(
            &with_pyproject,
            "pyproject.toml",
            "[project]\nname = \"demo\"\ndependencies = [\"pandas\"]\n",
        );

        let nb_in_project = write(&with_pyproject, "demo.ipynb", "{}");
        let nb_no_project = write(&bare, "demo.ipynb", "{}");

        // First location: Detected against pyproject.toml.
        let first = build_context(&nb_in_project);
        assert!(
            matches!(first, ProjectContext::Detected { .. }),
            "expected Detected for notebook under project dir, got {first:?}"
        );

        // Save-as to a bare directory: should now be NotFound, with no
        // leaked fields from the earlier Detected. `set_project_context`
        // does the field-clearing in the CRDT setter; here we just
        // confirm `build_context` returns the unambiguous answer for
        // the new path.
        let second = build_context(&nb_no_project);
        assert!(
            matches!(second, ProjectContext::NotFound { .. }),
            "expected NotFound for notebook in bare dir, got {second:?}"
        );
    }
}
