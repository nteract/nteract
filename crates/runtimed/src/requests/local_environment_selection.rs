//! Daemon-session environment intent is separate from the running kernel. A
//! revisioned apply lease freezes the staged target across asynchronous preflight
//! and launch; cancellation releases it without committing a failed binding.
//! Owners observe snapshots through a watch channel, never through NotebookDoc.
//! Apply and package sync share admission; the sync lease outlives a cancelled
//! caller while its runtime-agent query is pending. Only the prior agent is
//! protected during preflight, and authorized capture advances the heads fence
//! while the NotebookDoc write lock excludes concurrent dependency edits.

use std::sync::{Arc, Mutex, Weak};

use crate::{daemon::Daemon, notebook_sync_server::NotebookRoom};
use notebook_protocol::protocol::{
    EnvironmentIntentPersistence, EnvironmentSelectionSnapshot, LocalCondaEnvironment,
    LocalEnvironmentTarget, NotebookResponse,
};
use tokio::sync::watch;

/// Whether notebook metadata may still seed the staged intent. This is
/// separate from the revision: the revision only grows, while a runtime
/// session reset returns the selection to `Pending` so a reconnect re-imports
/// the saved named kernel intent.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Initialization {
    Pending,
    Initialized,
}

#[derive(Default)]
enum IntentSaveState {
    #[default]
    Current,
    Unsaved(String),
    Saving(String),
}

impl IntentSaveState {
    fn projection(&self) -> EnvironmentIntentPersistence {
        match self {
            Self::Current => EnvironmentIntentPersistence::Current,
            Self::Unsaved(_) => EnvironmentIntentPersistence::Unsaved,
            Self::Saving(_) => EnvironmentIntentPersistence::Saving,
        }
    }
}

enum IntentSaveEvent {
    ApplyCompleted { unsaved_runtime: Option<String> },
    RetryStarted,
    RetryCompleted,
    RetryAborted,
    Reset,
}

fn transition_intent_persistence(
    state: IntentSaveState,
    event: IntentSaveEvent,
) -> IntentSaveState {
    use IntentSaveState::{Current, Saving, Unsaved};
    match (state, event) {
        (_, IntentSaveEvent::Reset) => Current,
        (_, IntentSaveEvent::ApplyCompleted { unsaved_runtime }) => {
            unsaved_runtime.map_or(Current, Unsaved)
        }
        (Unsaved(runtime), IntentSaveEvent::RetryStarted) => Saving(runtime),
        (Saving(_), IntentSaveEvent::RetryCompleted) => Current,
        (Saving(runtime), IntentSaveEvent::RetryAborted) => Unsaved(runtime),
        (state, _) => state,
    }
}

fn staged_target_matches_applied(state: &EnvironmentSelectionSnapshot) -> bool {
    state.selected.as_ref().map(|env| &env.id) == state.applied.as_ref().map(|env| &env.id)
        && state.selected_kernelspec.as_ref().map(|spec| &spec.name)
            == state.applied_kernelspec.as_ref().map(|spec| &spec.name)
}

struct SelectionState {
    snapshot: EnvironmentSelectionSnapshot,
    initialization: Initialization,
    intent_save: IntentSaveState,
}

impl SelectionState {
    fn save_event(&mut self, event: IntentSaveEvent) {
        self.intent_save =
            transition_intent_persistence(std::mem::take(&mut self.intent_save), event);
        self.snapshot.intent_persistence = self.intent_save.projection();
    }
}

impl std::ops::Deref for SelectionState {
    type Target = EnvironmentSelectionSnapshot;
    fn deref(&self) -> &Self::Target {
        &self.snapshot
    }
}

impl std::ops::DerefMut for SelectionState {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.snapshot
    }
}

pub(crate) struct LocalEnvironmentSelection {
    state: Mutex<SelectionState>,
    changed: watch::Sender<EnvironmentSelectionSnapshot>,
    replacing: std::sync::atomic::AtomicBool,
    observed_heads: Mutex<Option<Vec<String>>>,
    preserved_agent_id: Mutex<Option<String>>,
    syncing: Mutex<Weak<()>>,
}

impl Default for LocalEnvironmentSelection {
    fn default() -> Self {
        let (changed, _) = watch::channel(EnvironmentSelectionSnapshot::default());
        Self {
            state: Mutex::new(SelectionState {
                snapshot: EnvironmentSelectionSnapshot::default(),
                initialization: Initialization::Pending,
                intent_save: IntentSaveState::Current,
            }),
            changed,
            replacing: std::sync::atomic::AtomicBool::new(false),
            observed_heads: Mutex::new(None),
            preserved_agent_id: Mutex::new(None),
            syncing: Mutex::new(Weak::new()),
        }
    }
}

impl LocalEnvironmentSelection {
    pub(crate) fn snapshot(&self) -> EnvironmentSelectionSnapshot {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .snapshot
            .clone()
    }

    /// Revision fence for metadata inference, captured before any await.
    /// `None` once an explicit choice or earlier import owns the intent.
    pub(crate) fn initialization_fence(&self) -> Option<u64> {
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        (state.initialization == Initialization::Pending && !state.applying)
            .then_some(state.revision)
    }

    pub(crate) fn subscribe(&self) -> watch::Receiver<EnvironmentSelectionSnapshot> {
        self.changed.subscribe()
    }

    pub(crate) fn set(
        &self,
        selected: Option<LocalCondaEnvironment>,
        expected_revision: u64,
    ) -> Result<EnvironmentSelectionSnapshot, String> {
        self.stage(selected, None, expected_revision)
    }

    fn stage(
        &self,
        selected: Option<LocalCondaEnvironment>,
        kernelspec: Option<notebook_protocol::protocol::InstalledKernelspec>,
        expected_revision: u64,
    ) -> Result<EnvironmentSelectionSnapshot, String> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        Self::validate(&state, expected_revision)?;
        state.selected = selected;
        state.selected_kernelspec = kernelspec;
        state.initialization = Initialization::Initialized;
        self.publish(&mut state);
        Ok(state.snapshot.clone())
    }

    pub(crate) fn begin_apply(
        &self,
        expected_revision: u64,
    ) -> Result<EnvironmentApply<'_>, String> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        Self::validate(&state, expected_revision)?;
        if self.sync_lease().is_some() {
            return Err("Environment sync in progress; retry after it completes".into());
        }
        Ok(self.start_apply(&mut state))
    }

    fn begin_save_retry(
        &self,
        expected_revision: u64,
    ) -> Result<(EnvironmentApply<'_>, String), String> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        Self::validate(&state, expected_revision)?;
        let IntentSaveState::Unsaved(runtime) = &state.intent_save else {
            return Err("No unsaved environment choice to retry".into());
        };
        if !staged_target_matches_applied(&state) {
            return Err("Environment selection changed; refresh and try again".into());
        }
        let runtime = runtime.clone();
        state.save_event(IntentSaveEvent::RetryStarted);
        Ok((self.start_apply(&mut state), runtime))
    }

    fn start_apply(&self, state: &mut SelectionState) -> EnvironmentApply<'_> {
        state.applying = true;
        *self
            .observed_heads
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = None;
        *self
            .preserved_agent_id
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = None;
        self.replacing
            .store(false, std::sync::atomic::Ordering::Release);
        self.publish(state);
        EnvironmentApply {
            selection: self,
            revision: state.revision,
        }
    }

    /// Preserve imported intent before discovery or launch can fail. `fence`
    /// comes from [`Self::initialization_fence`] before the metadata read; an
    /// explicit choice or reset in between advances the revision and wins.
    pub(crate) fn adopt_imported_kernelspec(
        &self,
        spec: notebook_protocol::protocol::InstalledKernelspec,
        fence: u64,
    ) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.initialization != Initialization::Pending
            || state.revision != fence
            || state.applying
        {
            return false;
        }
        state.selected_kernelspec = Some(spec);
        state.initialization = Initialization::Initialized;
        self.publish(&mut state);
        true
    }

    /// Automatic launch can resolve imported portable intent without a picker apply.
    pub(crate) fn record_launch(
        &self,
        spec: Option<&notebook_protocol::protocol::InstalledKernelspec>,
    ) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.applying || state.applied_kernelspec.as_ref() == spec {
            return;
        }
        if spec.is_some() {
            state.applied = None;
        }
        if state.initialization == Initialization::Pending && spec.is_some() {
            state.selected_kernelspec = spec.cloned();
            state.initialization = Initialization::Initialized;
        }
        state.applied_kernelspec = spec.cloned();
        // A non-Apply launch did not save notebook intent. Preserve the
        // pending save if it restarted the same choice (handled above), but
        // never offer to save a named kernel that it replaced.
        state.save_event(IntentSaveEvent::Reset);
        self.publish(&mut state);
    }

    pub(crate) fn begin_sync(&self) -> Result<Arc<()>, String> {
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.applying {
            return Err(
                "Wait for the environment selection to finish applying before syncing packages"
                    .into(),
            );
        }
        let mut syncing = self.syncing.lock().unwrap_or_else(|e| e.into_inner());
        if syncing.upgrade().is_some() {
            return Err("Environment sync in progress; retry after it completes".into());
        }
        let lease = Arc::new(());
        *syncing = Arc::downgrade(&lease);
        Ok(lease)
    }

    pub(crate) fn sync_lease(&self) -> Option<Arc<()>> {
        self.syncing
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .upgrade()
    }

    pub(crate) fn observed_heads(&self) -> Option<Vec<String>> {
        self.observed_heads
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    pub(crate) fn advance_capture_heads(&self, doc: &mut notebook_doc::NotebookDoc) {
        *self
            .observed_heads
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some(doc.get_heads_hex());
    }

    pub(crate) fn preserves_agent(&self, agent_id: Option<&str>) -> bool {
        self.is_preparing()
            && self
                .preserved_agent_id
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .as_deref()
                .is_some_and(|prior| agent_id.is_none_or(|id| id == prior))
    }

    fn validate(state: &EnvironmentSelectionSnapshot, expected: u64) -> Result<(), String> {
        if state.applying {
            return Err("Environment selection is being applied".into());
        }
        if state.revision != expected {
            return Err("Environment selection changed; refresh and try again".into());
        }
        Ok(())
    }

    fn publish(&self, state: &mut SelectionState) {
        state.revision += 1;
        self.changed.send_replace(state.snapshot.clone());
    }

    pub(crate) fn is_preparing(&self) -> bool {
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.applying
            && state.intent_persistence != EnvironmentIntentPersistence::Saving
            && !self.replacing.load(std::sync::atomic::Ordering::Acquire)
    }

    pub(crate) fn reset(&self) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.selected = None;
        state.applied = None;
        state.selected_kernelspec = None;
        state.applied_kernelspec = None;
        state.applying = false;
        state.save_event(IntentSaveEvent::Reset);
        state.initialization = Initialization::Pending;
        self.publish(&mut state);
    }
}

pub(crate) struct EnvironmentApply<'a> {
    selection: &'a LocalEnvironmentSelection,
    revision: u64,
}

impl EnvironmentApply<'_> {
    pub(crate) fn set_observed_heads(&self, heads: Vec<String>) {
        *self
            .selection
            .observed_heads
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some(heads);
    }

    pub(crate) fn preserve_agent(&self, agent_id: Option<String>) {
        *self
            .selection
            .preserved_agent_id
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = agent_id;
    }

    pub(crate) fn observed_heads(&self) -> Option<Vec<String>> {
        self.selection.observed_heads()
    }

    pub(crate) fn begin_replacement(&self) {
        self.selection
            .replacing
            .store(true, std::sync::atomic::Ordering::Release);
    }
    pub(crate) fn commit(
        &self,
        applied: Option<LocalCondaEnvironment>,
        unsaved_runtime: Option<String>,
    ) {
        let mut state = self
            .selection
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if state.revision == self.revision && state.applying {
            state.applied = applied;
            state.applied_kernelspec = state.selected_kernelspec.clone();
            state.save_event(IntentSaveEvent::ApplyCompleted { unsaved_runtime });
            state.applying = false;
            state.initialization = Initialization::Initialized;
            self.selection.publish(&mut state);
        }
    }

    fn commit_save_retry(
        &self,
        persist: impl FnOnce() -> anyhow::Result<()>,
    ) -> anyhow::Result<EnvironmentSelectionSnapshot> {
        let mut state = self
            .selection
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if state.revision != self.revision
            || !matches!(state.intent_save, IntentSaveState::Saving(_))
        {
            anyhow::bail!("Environment selection changed; refresh and try again");
        }
        persist()?;
        state.save_event(IntentSaveEvent::RetryCompleted);
        state.applying = false;
        self.selection.publish(&mut state);
        Ok(state.snapshot.clone())
    }
}

impl Drop for EnvironmentApply<'_> {
    fn drop(&mut self) {
        let mut state = self
            .selection
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if state.revision == self.revision && state.applying {
            state.save_event(IntentSaveEvent::RetryAborted);
            state.applying = false;
            self.selection.publish(&mut state);
        }
    }
}

pub(crate) async fn list(
    room: &NotebookRoom,
    daemon: &Arc<Daemon>,
    refresh: bool,
) -> NotebookResponse {
    if room.is_hosted() {
        return rejected("Local environments are unavailable for hosted notebooks".into());
    }
    match daemon.local_conda_environments.inventory(refresh).await {
        Ok(inventory) => NotebookResponse::CondaEnvironments { inventory },
        Err(error) => rejected(error),
    }
}

/// Read installed records from the actual running borrowed prefix, never the staged target.
pub(crate) async fn list_installed_packages(room: &NotebookRoom) -> NotebookResponse {
    if room.is_hosted() {
        return rejected("Local environments are unavailable for hosted notebooks".into());
    }
    let Some(launch_config) = room.runtime_agent_launched_config.read().await.clone() else {
        return rejected(
            "Start a local Conda environment before viewing installed packages".into(),
        );
    };
    if launch_config.installed_kernelspec.is_some() {
        return rejected(
            "Package inventory is externally managed for installed Jupyter kernels".into(),
        );
    }
    let Some(environment_identity) = launch_config.local_environment.as_ref() else {
        return rejected(
            "Installed package inventory is available only for a borrowed Conda environment".into(),
        );
    };
    let Some(prefix) = launch_config.venv_path else {
        return rejected("The running Conda prefix is unavailable".into());
    };
    let runtime_kernel = room
        .state
        .read(|state| state.read_state().kernel)
        .map_err(|error| format!("Cannot read runtime state: {error}"));
    let runtime_kernel = match runtime_kernel {
        Ok(kernel) => kernel,
        Err(error) => return rejected(error),
    };
    if runtime_kernel.lifecycle
        != runtime_doc::RuntimeLifecycle::Running(runtime_doc::KernelActivity::Idle)
        && !matches!(
            runtime_kernel.lifecycle,
            runtime_doc::RuntimeLifecycle::Running(runtime_doc::KernelActivity::Busy)
        )
    {
        return rejected("Installed package inventory requires a running kernel".into());
    }
    if runtime_kernel.environment_id != environment_identity.id {
        return rejected("Running environment identity is unavailable or stale".into());
    }
    match crate::local_conda_environments::LocalCondaEnvironments::installed_packages(prefix).await
    {
        Ok(inventory) => NotebookResponse::InstalledCondaPackages { inventory },
        Err(error) => rejected(error),
    }
}

async fn initialize_imported_intent(room: &NotebookRoom) {
    let Some(fence) = room.local_environment_selection.initialization_fence() else {
        return;
    };
    if matches!(
        room.bound_environment.snapshot(),
        super::bound_environment::BoundEnvironmentState::Bound(_)
    ) {
        return;
    }
    let mode = *room.identity.environment_mode.read().await;
    let metadata = {
        let doc = room.doc.read().await;
        doc.get_metadata_snapshot()
    };
    if let Some(name) = crate::kernelspec::imported(metadata.as_ref(), mode) {
        if let Some(intent) = metadata.and_then(|metadata| metadata.kernelspec) {
            room.local_environment_selection.adopt_imported_kernelspec(
                notebook_protocol::protocol::InstalledKernelspec {
                    name: name.to_ascii_lowercase(),
                    display_name: intent.display_name,
                    language: intent.language.unwrap_or_default(),
                },
                fence,
            );
        }
    }
}

pub(crate) async fn get(room: &NotebookRoom) -> NotebookResponse {
    if room.is_hosted() {
        return rejected("Local environments are unavailable for hosted notebooks".into());
    }
    // Discovery and execution may be blocked by trust or disabled autolaunch.
    // Reading the selection must still expose the notebook's named intent.
    initialize_imported_intent(room).await;
    NotebookResponse::EnvironmentSelection {
        selection: room.local_environment_selection.snapshot(),
    }
}

pub(crate) async fn set(
    room: &NotebookRoom,
    daemon: &Arc<Daemon>,
    target: LocalEnvironmentTarget,
    expected_revision: u64,
) -> NotebookResponse {
    if room.is_hosted() {
        return rejected("Local environments are unavailable for hosted notebooks".into());
    }
    if let Err(error) = LocalEnvironmentSelection::validate(
        &room.local_environment_selection.snapshot(),
        expected_revision,
    ) {
        return rejected(error);
    }
    let selected = match target {
        LocalEnvironmentTarget::Kernelspec { name } => {
            let spec = match crate::kernelspec::resolve(name.clone()).await {
                Ok(s) => s.info(&name),
                Err(e) => return rejected(format!("{e:#}")),
            };
            return match room
                .local_environment_selection
                .stage(None, Some(spec), expected_revision)
            {
                Ok(selection) => NotebookResponse::EnvironmentSelection { selection },
                Err(e) => rejected(e),
            };
        }
        LocalEnvironmentTarget::Automatic => None,
        LocalEnvironmentTarget::Conda { prefix } => {
            match daemon.local_conda_environments.resolve_prefix(prefix).await {
                Ok(environment) => Some(environment),
                Err(error) => return rejected(error),
            }
        }
    };
    match room
        .local_environment_selection
        .set(selected, expected_revision)
    {
        Ok(selection) => NotebookResponse::EnvironmentSelection { selection },
        Err(error) => rejected(error),
    }
}

pub(crate) async fn apply(
    room: &Arc<NotebookRoom>,
    daemon: &Arc<Daemon>,
    expected_revision: u64,
    observed_heads: Vec<String>,
) -> NotebookResponse {
    use crate::notebook_sync_server::ManualLaunchAdmission;
    use notebook_protocol::connection::LaunchSpec;
    if room.is_hosted() {
        return rejected("Local environments are unavailable for hosted notebooks".into());
    }
    initialize_imported_intent(room).await;
    if let Err(rejection) = super::guarded::ensure_trusted(room).await {
        return rejection.into_response();
    }
    let snapshot = room.local_environment_selection.snapshot();
    if let Err(error) = LocalEnvironmentSelection::validate(&snapshot, expected_revision) {
        return rejected(error);
    }
    if snapshot.intent_persistence == EnvironmentIntentPersistence::Unsaved
        && staged_target_matches_applied(&snapshot)
    {
        return retry_save(room, &snapshot, &observed_heads).await;
    }
    let runtime = crate::notebook_sync_server::resolve_metadata_snapshot(
        room,
        room.file_binding.path().await.as_deref(),
    )
    .await
    .and_then(|metadata| metadata.detect_runtime());
    if snapshot.selected.is_some() && runtime.as_deref() == Some("deno") {
        return rejected("Local Conda selection is only available for Python notebooks".into());
    }
    let chosen = match snapshot.selected {
        Some(environment) => match daemon
            .local_conda_environments
            .resolve_prefix(environment.prefix)
            .await
        {
            Ok(environment) => Some(environment),
            Err(error) => return rejected(error),
        },
        None if snapshot.selected_kernelspec.is_some() => None,
        None => {
            let path = match room.file_binding.path().await {
                Some(path) => Some(path),
                None => room.identity.working_dir.read().await.clone(),
            };
            // Check before the old kernel stops: Automatic would park on an
            // untrusted project and leave the notebook without a kernel.
            let environment_mode = *room.identity.environment_mode.read().await;
            if let Some(detected) =
                automatic_project_file(path.as_deref(), environment_mode, runtime.as_deref())
            {
                if crate::project_trust::evaluate_for_room(room, &detected).verdict
                    == crate::project_trust::ProjectTrustVerdict::NeedsApproval
                {
                    return rejected("Trust the project folder before applying Automatic".into());
                }
            }
            None
        }
    };
    // Revalidate after passive I/O and before any old-kernel side effect.
    if let Err(rejection) = super::guarded::ensure_trusted(room).await {
        return rejection.into_response();
    }
    {
        let doc = room.doc.read().await;
        if let Err(rejection) =
            super::guarded::validate_dependencies_unchanged_since_observed(&doc, &observed_heads)
        {
            return rejection.into_response();
        }
    }
    let attempt = match room.try_begin_manual_launch() {
        ManualLaunchAdmission::Admitted(attempt) => attempt,
        ManualLaunchAdmission::InFlight { .. } => {
            return rejected("A kernel launch is already in progress".into())
        }
    };
    let lease = match room
        .local_environment_selection
        .begin_apply(expected_revision)
    {
        Ok(lease) => lease,
        Err(error) => {
            attempt.release_without_cooldown();
            return rejected(error);
        }
    };
    lease.set_observed_heads(observed_heads);
    let response = super::launch_kernel::handle_admitted(
        room,
        daemon,
        "auto".into(),
        LaunchSpec::Auto,
        None,
        attempt,
        chosen,
        Some(lease),
    )
    .await;
    if matches!(response, NotebookResponse::KernelLaunched { .. }) {
        get(room).await
    } else {
        response
    }
}

/// Retry against fresh reviewed heads without resolving, starting or replacing
/// the kernel. The pending choice remains saveable even if the kernel stops.
async fn retry_save(
    room: &NotebookRoom,
    snapshot: &EnvironmentSelectionSnapshot,
    observed_heads: &[String],
) -> NotebookResponse {
    let mut doc = room.doc.write().await;
    room.commit_without_launch(|| {
        if let Err(rejection) = super::guarded::ensure_trusted_for_doc(room, &doc).and_then(|()| {
            super::guarded::validate_dependencies_unchanged_since_observed(&doc, observed_heads)
        }) {
            return rejection.into_response();
        }
        let (lease, runtime) = match room
            .local_environment_selection
            .begin_save_retry(snapshot.revision)
        {
            Ok(retry) => retry,
            Err(error) => return rejected(error),
        };
        match lease.commit_save_retry(|| {
            crate::kernelspec::persist(
                room,
                &mut doc,
                snapshot.applied_kernelspec.as_ref(),
                &runtime,
            )
        }) {
            Ok(selection) => NotebookResponse::EnvironmentSelection { selection },
            Err(error) => NotebookResponse::Error {
                error: format!("Selection not saved: {error:#}"),
            },
        }
    })
    .unwrap_or_else(|| rejected("A kernel launch is already in progress".into()))
}

/// Match Automatic launch policy before disturbing the running kernel.
fn automatic_project_file(
    path: Option<&std::path::Path>,
    mode: notebook_protocol::connection::CreateNotebookEnvironmentMode,
    runtime: Option<&str>,
) -> Option<crate::project_file::DetectedProjectFile> {
    if !mode.allows_project_files() || runtime == Some("deno") {
        return None;
    }
    path.and_then(crate::project_file::detect_project_file)
}

fn rejected(error: String) -> NotebookResponse {
    NotebookResponse::EnvironmentSelectionRejected { error }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn automatic_project_preflight_matches_runtime_and_environment_mode() {
        use notebook_protocol::connection::CreateNotebookEnvironmentMode as Mode;
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(
            temp.path().join("pyproject.toml"),
            "[project]\ndependencies = []\n",
        )
        .unwrap();
        let path = temp.path().join("notebook.ipynb");
        assert!(automatic_project_file(Some(&path), Mode::Auto, Some("python")).is_some());
        assert!(automatic_project_file(Some(&path), Mode::Project, Some("python")).is_some());
        assert!(automatic_project_file(Some(&path), Mode::Notebook, Some("python")).is_none());
        assert!(automatic_project_file(Some(&path), Mode::Auto, Some("deno")).is_none());
        assert!(automatic_project_file(Some(&path), Mode::Auto, None).is_some());
    }

    #[tokio::test]
    async fn installed_inventory_requires_actual_borrowed_running_config() {
        let temp = tempfile::TempDir::new().unwrap();
        let room = Arc::new(crate::notebook_sync_server::NotebookRoom::new_fresh(
            uuid::Uuid::new_v4(),
            None,
            temp.path(),
            Arc::new(crate::blob_store::BlobStore::new(temp.path().join("blobs"))),
            false,
        ));
        assert!(matches!(
            list_installed_packages(&room).await,
            NotebookResponse::EnvironmentSelectionRejected { ref error }
                if error.contains("Start a local Conda environment")
        ));
        let managed = notebook_protocol::protocol::LaunchedEnvConfig {
            venv_path: Some(temp.path().to_owned()),
            ..Default::default()
        };
        *room.runtime_agent_launched_config.write().await = Some(managed);
        assert!(matches!(
            list_installed_packages(&room).await,
            NotebookResponse::EnvironmentSelectionRejected { ref error }
                if error.contains("borrowed Conda")
        ));
    }

    #[tokio::test]
    async fn installed_inventory_rejects_stopped_kernel_with_retained_config() {
        let temp = tempfile::TempDir::new().unwrap();
        let room = Arc::new(crate::notebook_sync_server::NotebookRoom::new_fresh(
            uuid::Uuid::new_v4(),
            None,
            temp.path(),
            Arc::new(crate::blob_store::BlobStore::new(temp.path().join("blobs"))),
            false,
        ));
        let prefix = temp.path().join("borrowed");
        std::fs::create_dir_all(prefix.join("conda-meta")).unwrap();
        let config = notebook_protocol::protocol::LaunchedEnvConfig {
            venv_path: Some(prefix),
            local_environment: Some(notebook_protocol::protocol::LocalEnvironmentIdentity {
                id: "local-rankings".into(),
                name: "rankings".into(),
                python_version: None,
            }),
            ..Default::default()
        };
        *room.runtime_agent_launched_config.write().await = Some(config);
        assert!(matches!(
            list_installed_packages(&room).await,
            NotebookResponse::EnvironmentSelectionRejected { ref error }
                if error.contains("running kernel")
        ));
    }

    fn environment(name: &str) -> LocalCondaEnvironment {
        LocalCondaEnvironment {
            id: format!("conda:{name}"),
            name: name.into(),
            prefix: PathBuf::from(format!("/envs/{name}")),
            python_path: PathBuf::from(format!("/envs/{name}/bin/python")),
            python_version: Some("3.12".into()),
        }
    }

    #[test]
    fn selection_is_staged_and_revision_checked_until_successful_apply() {
        let selection = LocalEnvironmentSelection::default();
        let mut changes = selection.subscribe();
        let staged = selection.set(Some(environment("rankings")), 0).unwrap();
        assert_eq!(staged.revision, 1);
        assert!(staged.applied.is_none());
        assert!(changes.has_changed().unwrap());
        assert_eq!(changes.borrow_and_update().selected, staged.selected);
        assert!(selection.set(None, 0).is_err());
        let apply = selection.begin_apply(1).unwrap();
        assert!(selection.snapshot().applying);
        assert!(selection.set(None, 2).is_err());
        assert!(selection.begin_apply(2).is_err());
        apply.commit(Some(environment("rankings")), None);
        let committed = selection.snapshot();
        assert_eq!(committed.revision, 3);
        assert_eq!(committed.applied, committed.selected);
        assert!(!committed.applying);
        selection.set(None, 3).unwrap();
        assert_eq!(selection.snapshot().applied, committed.applied);
    }

    #[test]
    fn failed_apply_keeps_choice_and_old_binding_and_releases_lease() {
        let selection = LocalEnvironmentSelection::default();
        selection.set(Some(environment("old")), 0).unwrap();
        selection
            .begin_apply(1)
            .unwrap()
            .commit(Some(environment("old")), None);
        selection.set(Some(environment("new")), 3).unwrap();
        drop(selection.begin_apply(4).unwrap());
        let snapshot = selection.snapshot();
        assert_eq!(snapshot.selected.unwrap().name, "new");
        assert_eq!(snapshot.applied.unwrap().name, "old");
        assert!(!snapshot.applying);
        assert_eq!(snapshot.revision, 6);
    }

    #[test]
    fn save_retry_is_revisioned_and_failure_preserves_unsaved_choice() {
        use EnvironmentIntentPersistence::{Current, Saving, Unsaved};
        let selection = LocalEnvironmentSelection::default();
        selection
            .begin_apply(0)
            .unwrap()
            .commit(None, Some("python".into()));
        let unsaved = selection.snapshot();
        assert_eq!(unsaved.intent_persistence, Unsaved);
        assert!(selection.begin_save_retry(unsaved.revision - 1).is_err());
        let (retry, runtime) = selection.begin_save_retry(unsaved.revision).unwrap();
        assert_eq!(runtime, "python");
        let saving = selection.snapshot();
        assert_eq!(saving.intent_persistence, Saving);
        assert!(saving.applying);
        assert!(!selection.is_preparing());
        assert!(selection.begin_apply(saving.revision).is_err());
        assert!(retry
            .commit_save_retry(|| anyhow::bail!("write failed"))
            .is_err());
        drop(retry);
        let unsaved = selection.snapshot();
        assert_eq!(unsaved.intent_persistence, Unsaved);
        assert!(!unsaved.applying);
        let staged = selection
            .set(Some(environment("new")), unsaved.revision)
            .unwrap();
        assert!(selection.begin_save_retry(staged.revision).is_err());
        let restaged = selection.set(None, staged.revision).unwrap();
        let (retry, _) = selection.begin_save_retry(restaged.revision).unwrap();
        selection.reset();
        assert!(retry
            .commit_save_retry(|| panic!("reset invalidates retry"))
            .is_err());
        assert_eq!(selection.snapshot().intent_persistence, Current);
    }

    #[test]
    fn runtime_session_reset_invalidates_inflight_completion() {
        let selection = LocalEnvironmentSelection::default();
        selection.set(Some(environment("old")), 0).unwrap();
        let apply = selection.begin_apply(1).unwrap();
        selection.reset();
        apply.commit(Some(environment("old")), None);
        let snapshot = selection.snapshot();
        assert_eq!(snapshot.revision, 3);
        assert!(snapshot.selected.is_none());
        assert!(snapshot.applied.is_none());
        assert!(!snapshot.applying);
    }

    #[test]
    fn kernelspec_stage_and_apply_share_conda_revision() {
        let selection = LocalEnvironmentSelection::default();
        let target = notebook_protocol::protocol::InstalledKernelspec {
            name: "ir".into(),
            display_name: "R".into(),
            language: "R".into(),
        };
        selection.stage(None, Some(target.clone()), 0).unwrap();
        let lease = selection.begin_apply(1).unwrap();
        assert!(selection.set(None, 2).is_err());
        lease.commit(None, None);
        let staged = selection.set(Some(environment("other")), 3).unwrap();
        assert!(staged.selected_kernelspec.is_none());
        assert_eq!(staged.applied_kernelspec, Some(target));
        drop(selection.begin_apply(4).unwrap());
        assert!(selection.snapshot().applied_kernelspec.is_some());
        selection
            .begin_apply(6)
            .unwrap()
            .commit(Some(environment("other")), None);
        assert!(selection.snapshot().applied_kernelspec.is_none());
    }

    #[test]
    fn imported_intent_is_not_applied_and_cannot_replace_an_explicit_choice() {
        let selection = LocalEnvironmentSelection::default();
        let spec = notebook_protocol::protocol::InstalledKernelspec {
            name: "missing-julia".into(),
            display_name: "Julia".into(),
            language: "julia".into(),
        };
        let fence = selection.initialization_fence().unwrap();
        assert!(selection.adopt_imported_kernelspec(spec.clone(), fence));
        assert!(selection.initialization_fence().is_none());
        let imported = selection.snapshot();
        assert_eq!(imported.selected_kernelspec, Some(spec.clone()));
        assert!(imported.applied_kernelspec.is_none());
        assert!(!imported.applying);
        let automatic = selection.set(None, imported.revision).unwrap();
        assert!(!selection.adopt_imported_kernelspec(spec, automatic.revision));
        assert_eq!(selection.snapshot(), automatic);
        assert!(automatic.selected_kernelspec.is_none());
    }

    #[tokio::test]
    async fn initial_selection_exposes_imported_intent_without_launch_or_discovery() {
        let temp = tempfile::tempdir().unwrap();
        let room = NotebookRoom::new_fresh(
            uuid::Uuid::new_v4(),
            None,
            temp.path(),
            Arc::new(crate::blob_store::BlobStore::new(temp.path().join("blobs"))),
            false,
        );
        {
            let mut metadata = notebook_doc::metadata::NotebookMetadataSnapshot::default();
            metadata.kernelspec = Some(notebook_doc::metadata::KernelspecSnapshot {
                name: "uninstalled-julia".into(),
                display_name: "Julia".into(),
                language: Some("julia".into()),
                ..Default::default()
            });
            metadata.add_uv_dependency("numpy");
            room.doc
                .write()
                .await
                .set_metadata_snapshot(&metadata)
                .unwrap();
        }
        *room.identity.environment_mode.write().await =
            notebook_protocol::connection::CreateNotebookEnvironmentMode::Project;
        assert!(
            matches!(get(&room).await, NotebookResponse::EnvironmentSelection { selection } if selection.selected_kernelspec.is_none())
        );
        *room.identity.environment_mode.write().await =
            notebook_protocol::connection::CreateNotebookEnvironmentMode::Auto;
        let NotebookResponse::EnvironmentSelection { selection } = get(&room).await else {
            panic!("expected local selection")
        };
        assert_eq!(
            selection.selected_kernelspec.as_ref().unwrap().name,
            "uninstalled-julia"
        );
        assert!(selection.applied_kernelspec.is_none());
        assert!(!selection.applying);
        room.local_environment_selection
            .set(None, selection.revision)
            .unwrap();
        assert!(
            matches!(get(&room).await, NotebookResponse::EnvironmentSelection { selection } if selection.selected_kernelspec.is_none())
        );
    }

    fn missing_spec() -> notebook_protocol::protocol::InstalledKernelspec {
        notebook_protocol::protocol::InstalledKernelspec {
            name: "missing-julia".into(),
            display_name: "Julia".into(),
            language: "julia".into(),
        }
    }

    #[test]
    fn reset_returns_initialization_to_pending_at_a_newer_revision() {
        let selection = LocalEnvironmentSelection::default();
        let fence = selection.initialization_fence().unwrap();
        assert!(selection.adopt_imported_kernelspec(missing_spec(), fence));
        let before = selection.snapshot().revision;
        selection.reset();
        let fence = selection.initialization_fence().expect("reset is pending");
        assert!(fence > before);
        assert!(selection.adopt_imported_kernelspec(missing_spec(), fence));
        let restored = selection.snapshot();
        assert_eq!(restored.selected_kernelspec, Some(missing_spec()));
        assert!(restored.revision > fence);
    }

    #[test]
    fn stale_initialization_is_rejected_after_reset_or_explicit_choice() {
        let selection = LocalEnvironmentSelection::default();
        let stale = selection.initialization_fence().unwrap();
        selection.reset();
        assert!(!selection.adopt_imported_kernelspec(missing_spec(), stale));
        assert!(selection.snapshot().selected_kernelspec.is_none());

        let stale = selection.initialization_fence().unwrap();
        let automatic = selection.set(None, stale).unwrap();
        assert!(!selection.adopt_imported_kernelspec(missing_spec(), stale));
        assert!(selection.initialization_fence().is_none());
        assert_eq!(selection.snapshot(), automatic);
    }

    #[test]
    fn launch_publication_does_not_resurrect_choice_after_explicit_automatic() {
        let selection = LocalEnvironmentSelection::default();
        selection.reset();
        let automatic = selection.set(None, selection.snapshot().revision).unwrap();
        selection.record_launch(Some(&missing_spec()));
        let snapshot = selection.snapshot();
        assert!(snapshot.selected_kernelspec.is_none());
        assert_eq!(snapshot.applied_kernelspec, Some(missing_spec()));
        assert!(snapshot.revision > automatic.revision);
    }

    #[tokio::test]
    async fn retained_room_reset_restores_imported_intent_and_keeps_explicit_automatic() {
        let temp = tempfile::tempdir().unwrap();
        let room = NotebookRoom::new_fresh(
            uuid::Uuid::new_v4(),
            None,
            temp.path(),
            Arc::new(crate::blob_store::BlobStore::new(temp.path().join("blobs"))),
            false,
        );
        {
            let mut metadata = notebook_doc::metadata::NotebookMetadataSnapshot::default();
            metadata.kernelspec = Some(notebook_doc::metadata::KernelspecSnapshot {
                name: "uninstalled-julia".into(),
                display_name: "Julia".into(),
                language: Some("julia".into()),
                ..Default::default()
            });
            room.doc
                .write()
                .await
                .set_metadata_snapshot(&metadata)
                .unwrap();
        }
        let get_selection = || async {
            let NotebookResponse::EnvironmentSelection { selection } = get(&room).await else {
                panic!("expected local selection")
            };
            selection
        };
        let first = get_selection().await;
        assert_eq!(
            first.selected_kernelspec.as_ref().unwrap().name,
            "uninstalled-julia"
        );
        // Last-peer teardown on a retained room; reconnect with no autolaunch.
        room.local_environment_selection.reset();
        let restored = get_selection().await;
        assert_eq!(restored.selected_kernelspec, first.selected_kernelspec);
        assert!(restored.applied_kernelspec.is_none());
        assert!(restored.revision > first.revision + 1);

        room.local_environment_selection.reset();
        let pending = room.local_environment_selection.snapshot();
        let automatic = room
            .local_environment_selection
            .set(None, pending.revision)
            .unwrap();
        let after = get_selection().await;
        assert_eq!(after, automatic);
        assert!(after.selected_kernelspec.is_none());
    }
}
