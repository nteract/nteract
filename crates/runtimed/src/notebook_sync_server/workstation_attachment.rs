use std::path::Path;

use runtime_doc::{RuntimeStateHandle, WorkstationAttachmentState};
use tracing::warn;

/// Publish the daemon-local workstation attachment into RuntimeStateDoc.
///
/// The visible desktop shell already projects a local runtime target from the
/// daemon session. This durable RuntimeStateDoc projection gives collaborators,
/// late joiners, and non-React hosts the same room-owned compute attachment
/// facts without polling a separate workstation resource.
pub(crate) fn publish_local_workstation_attachment_for_notebook_path(
    state: &RuntimeStateHandle,
    notebook_path: Option<&Path>,
) {
    let working_directory = notebook_path.and_then(workstation_working_directory_for_notebook_path);
    publish_local_workstation_attachment(state, working_directory);
}

/// Publish/update the daemon-local workstation attachment for an untitled
/// notebook with an explicit working directory.
pub(crate) fn publish_local_workstation_attachment_for_working_dir(
    state: &RuntimeStateHandle,
    working_dir: Option<&Path>,
) {
    let working_directory = working_dir.map(workstation_path_label);
    publish_local_workstation_attachment(state, working_directory);
}

fn publish_local_workstation_attachment(
    state: &RuntimeStateHandle,
    working_directory: Option<String>,
) {
    let attachment = local_workstation_attachment(working_directory);
    if let Err(error) = state.with_doc(|sd| sd.set_workstation_attachment(Some(&attachment))) {
        warn!(
            "[runtime-state] failed to publish local workstation attachment: {}",
            error
        );
    }
}

fn local_workstation_attachment(working_directory: Option<String>) -> WorkstationAttachmentState {
    WorkstationAttachmentState {
        workstation_id: "local-daemon".to_string(),
        display_name: "This machine".to_string(),
        provider: "local_daemon".to_string(),
        default_environment_label: "Notebook runtime".to_string(),
        environment_policy: "daemon".to_string(),
        status: "ready".to_string(),
        status_message: None,
        cpu_count: std::thread::available_parallelism()
            .ok()
            .map(|count| count.get() as u64),
        memory_bytes: None,
        working_directory,
        // Deliberately unset: local daemon attachment should not create head
        // churn merely because a constructor/bind path republished it.
        updated_at: None,
    }
}

fn workstation_working_directory_for_notebook_path(notebook_path: &Path) -> Option<String> {
    notebook_path.parent().map(workstation_path_label)
}

fn workstation_path_label(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[cfg(test)]
pub(crate) fn publish_local_workstation_attachment_for_test(
    state: &RuntimeStateHandle,
    working_directory: Option<String>,
) -> Result<(), runtime_doc::RuntimeStateError> {
    let attachment = local_workstation_attachment(working_directory);
    state.with_doc(|sd| sd.set_workstation_attachment(Some(&attachment)))
}
