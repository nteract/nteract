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
    EnvironmentSelectionSnapshot, LocalCondaEnvironment, LocalEnvironmentTarget, NotebookResponse,
};
use tokio::sync::watch;

pub(crate) struct LocalEnvironmentSelection {
    state: Mutex<EnvironmentSelectionSnapshot>,
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
            state: Mutex::new(EnvironmentSelectionSnapshot::default()),
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
        self.state.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub(crate) fn subscribe(&self) -> watch::Receiver<EnvironmentSelectionSnapshot> {
        self.changed.subscribe()
    }

    pub(crate) fn set(
        &self,
        selected: Option<LocalCondaEnvironment>,
        expected_revision: u64,
    ) -> Result<EnvironmentSelectionSnapshot, String> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        Self::validate(&state, expected_revision)?;
        state.selected = selected;
        self.publish(&mut state);
        Ok(state.clone())
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
        self.publish(&mut state);
        Ok(EnvironmentApply {
            selection: self,
            revision: state.revision,
        })
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

    fn publish(&self, state: &mut EnvironmentSelectionSnapshot) {
        state.revision += 1;
        self.changed.send_replace(state.clone());
    }

    pub(crate) fn is_preparing(&self) -> bool {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .applying
            && !self.replacing.load(std::sync::atomic::Ordering::Acquire)
    }

    pub(crate) fn reset(&self) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.selected = None;
        state.applied = None;
        state.applying = false;
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
    pub(crate) fn commit(&self, applied: Option<LocalCondaEnvironment>) {
        let mut state = self
            .selection
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if state.revision == self.revision && state.applying {
            state.applied = applied;
            state.applying = false;
            self.selection.publish(&mut state);
        }
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

pub(crate) fn get(room: &NotebookRoom) -> NotebookResponse {
    if room.is_hosted() {
        return rejected("Local environments are unavailable for hosted notebooks".into());
    }
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
    use crate::notebook_sync_server::{
        missing_conda_env_yml_decision, project_environment_build_approved, ManualLaunchAdmission,
    };
    use notebook_protocol::connection::LaunchSpec;
    if room.is_hosted() {
        return rejected("Local environments are unavailable for hosted notebooks".into());
    }
    if let Err(rejection) = super::guarded::ensure_trusted(room).await {
        return rejection.into_response();
    }
    let snapshot = room.local_environment_selection.snapshot();
    if let Err(error) = LocalEnvironmentSelection::validate(&snapshot, expected_revision) {
        return rejected(error);
    }
    if snapshot.selected.is_some()
        && room
            .doc
            .read()
            .await
            .get_metadata_snapshot()
            .and_then(|metadata| metadata.detect_runtime())
            .as_deref()
            == Some("deno")
    {
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
        None => {
            let path = match room.file_binding.path().await {
                Some(path) => Some(path),
                None => room.identity.working_dir.read().await.clone(),
            };
            if let Some(detected) = path
                .as_deref()
                .and_then(crate::project_file::detect_project_file)
            {
                if missing_conda_env_yml_decision(&detected).is_some()
                    && !project_environment_build_approved(room, &detected)
                {
                    return rejected("Review and approve the project environment build before applying Automatic".into());
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
        get(room)
    } else {
        response
    }
}

fn rejected(error: String) -> NotebookResponse {
    NotebookResponse::EnvironmentSelectionRejected { error }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

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
        apply.commit(Some(environment("rankings")));
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
            .commit(Some(environment("old")));
        selection.set(Some(environment("new")), 3).unwrap();
        drop(selection.begin_apply(4).unwrap());
        let snapshot = selection.snapshot();
        assert_eq!(snapshot.selected.unwrap().name, "new");
        assert_eq!(snapshot.applied.unwrap().name, "old");
        assert!(!snapshot.applying);
        assert_eq!(snapshot.revision, 6);
    }

    #[test]
    fn runtime_session_reset_invalidates_inflight_completion() {
        let selection = LocalEnvironmentSelection::default();
        selection.set(Some(environment("old")), 0).unwrap();
        let apply = selection.begin_apply(1).unwrap();
        selection.reset();
        apply.commit(Some(environment("old")));
        let snapshot = selection.snapshot();
        assert_eq!(snapshot.revision, 3);
        assert!(snapshot.selected.is_none());
        assert!(snapshot.applied.is_none());
        assert!(!snapshot.applying);
    }
}
