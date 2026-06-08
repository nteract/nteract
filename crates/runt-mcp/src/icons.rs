//! Generated monochrome MCP icons for resources and tools.

use base64::Engine as _;
use rmcp::model::{Icon, IconTheme};

const MIME_TYPE: &str = "image/png";
const SIZE: &str = "96x96";

#[derive(Debug, Clone, Copy)]
pub(crate) enum IconKind {
    CreateCell,
    CreateNotebook,
    DeleteCell,
    DisconnectNotebook,
    EditCell,
    GetResults,
    InterruptKernel,
    ListActiveNotebooks,
    ManageDependencies,
    MoveCell,
    OpenNotebook,
    ReadCell,
    ReplaceCell,
    RestartKernel,
    RunAllCells,
    RunCell,
    SaveNotebook,
}

pub(crate) fn icons(kind: IconKind) -> Vec<Icon> {
    vec![
        icon(light_bytes(kind), IconTheme::Light),
        icon(dark_bytes(kind), IconTheme::Dark),
    ]
}

pub(crate) fn tool_icon(name: &str) -> Option<IconKind> {
    Some(match name {
        "list_active_notebooks" => IconKind::ListActiveNotebooks,
        "connect_notebook" | "show_notebook" => IconKind::OpenNotebook,
        "create_notebook" => IconKind::CreateNotebook,
        "save_notebook" => IconKind::SaveNotebook,
        "disconnect_notebook" => IconKind::DisconnectNotebook,
        "get_cell" => IconKind::ReadCell,
        "get_all_cells" => IconKind::ListActiveNotebooks,
        "create_cell" => IconKind::CreateCell,
        "set_cell" => IconKind::EditCell,
        "delete_cell" => IconKind::DeleteCell,
        "move_cell" => IconKind::MoveCell,
        "execute_cell" => IconKind::RunCell,
        "run_all_cells" => IconKind::RunAllCells,
        "get_results" => IconKind::GetResults,
        "interrupt_kernel" => IconKind::InterruptKernel,
        "restart_kernel" => IconKind::RestartKernel,
        "manage_dependencies" => IconKind::ManageDependencies,
        "replace_match" | "replace_regex" => IconKind::ReplaceCell,
        "list_credentials" | "get_sandbox_status" | "get_notebook_sandbox_profile" => {
            IconKind::ReadCell
        }
        "set_notebook_sandbox_profile" => IconKind::EditCell,
        _ => return None,
    })
}

fn icon(bytes: &[u8], theme: IconTheme) -> Icon {
    Icon::new(format!(
        "data:{MIME_TYPE};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
    .with_mime_type(MIME_TYPE)
    .with_sizes(vec![SIZE.to_string()])
    .with_theme(theme)
}

fn light_bytes(kind: IconKind) -> &'static [u8] {
    match kind {
        IconKind::CreateCell => include_bytes!("../assets/icons/light/create-cell.png"),
        IconKind::CreateNotebook => include_bytes!("../assets/icons/light/create-notebook.png"),
        IconKind::DeleteCell => include_bytes!("../assets/icons/light/delete-cell.png"),
        IconKind::DisconnectNotebook => {
            include_bytes!("../assets/icons/light/disconnect-notebook.png")
        }
        IconKind::EditCell => include_bytes!("../assets/icons/light/edit-cell.png"),
        IconKind::GetResults => include_bytes!("../assets/icons/light/get-results.png"),
        IconKind::InterruptKernel => {
            include_bytes!("../assets/icons/light/interrupt-kernel.png")
        }
        IconKind::ListActiveNotebooks => {
            include_bytes!("../assets/icons/light/list-active-notebooks.png")
        }
        IconKind::ManageDependencies => {
            include_bytes!("../assets/icons/light/manage-dependencies.png")
        }
        IconKind::MoveCell => include_bytes!("../assets/icons/light/move-cell.png"),
        IconKind::OpenNotebook => include_bytes!("../assets/icons/light/open-notebook.png"),
        IconKind::ReadCell => include_bytes!("../assets/icons/light/read-cell.png"),
        IconKind::ReplaceCell => include_bytes!("../assets/icons/light/replace-cell.png"),
        IconKind::RestartKernel => include_bytes!("../assets/icons/light/restart-kernel.png"),
        IconKind::RunAllCells => include_bytes!("../assets/icons/light/run-all-cells.png"),
        IconKind::RunCell => include_bytes!("../assets/icons/light/run-cell.png"),
        IconKind::SaveNotebook => include_bytes!("../assets/icons/light/save-notebook.png"),
    }
}

fn dark_bytes(kind: IconKind) -> &'static [u8] {
    match kind {
        IconKind::CreateCell => include_bytes!("../assets/icons/dark/create-cell.png"),
        IconKind::CreateNotebook => include_bytes!("../assets/icons/dark/create-notebook.png"),
        IconKind::DeleteCell => include_bytes!("../assets/icons/dark/delete-cell.png"),
        IconKind::DisconnectNotebook => {
            include_bytes!("../assets/icons/dark/disconnect-notebook.png")
        }
        IconKind::EditCell => include_bytes!("../assets/icons/dark/edit-cell.png"),
        IconKind::GetResults => include_bytes!("../assets/icons/dark/get-results.png"),
        IconKind::InterruptKernel => include_bytes!("../assets/icons/dark/interrupt-kernel.png"),
        IconKind::ListActiveNotebooks => {
            include_bytes!("../assets/icons/dark/list-active-notebooks.png")
        }
        IconKind::ManageDependencies => {
            include_bytes!("../assets/icons/dark/manage-dependencies.png")
        }
        IconKind::MoveCell => include_bytes!("../assets/icons/dark/move-cell.png"),
        IconKind::OpenNotebook => include_bytes!("../assets/icons/dark/open-notebook.png"),
        IconKind::ReadCell => include_bytes!("../assets/icons/dark/read-cell.png"),
        IconKind::ReplaceCell => include_bytes!("../assets/icons/dark/replace-cell.png"),
        IconKind::RestartKernel => include_bytes!("../assets/icons/dark/restart-kernel.png"),
        IconKind::RunAllCells => include_bytes!("../assets/icons/dark/run-all-cells.png"),
        IconKind::RunCell => include_bytes!("../assets/icons/dark/run-cell.png"),
        IconKind::SaveNotebook => include_bytes!("../assets/icons/dark/save-notebook.png"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn icons_include_light_and_dark_png_data_uris() {
        let icons = icons(IconKind::CreateCell);
        let expected_sizes = vec![SIZE.to_string()];

        assert_eq!(icons.len(), 2);
        assert_eq!(icons[0].mime_type.as_deref(), Some(MIME_TYPE));
        assert_eq!(icons[0].sizes.as_ref(), Some(&expected_sizes));
        assert_eq!(icons[0].theme, Some(IconTheme::Light));
        assert!(icons[0].src.starts_with("data:image/png;base64,"));

        assert_eq!(icons[1].mime_type.as_deref(), Some(MIME_TYPE));
        assert_eq!(icons[1].sizes.as_ref(), Some(&expected_sizes));
        assert_eq!(icons[1].theme, Some(IconTheme::Dark));
        assert!(icons[1].src.starts_with("data:image/png;base64,"));
    }

    #[test]
    fn common_tool_names_map_to_operation_icons() {
        assert!(matches!(
            tool_icon("create_cell"),
            Some(IconKind::CreateCell)
        ));
        assert!(matches!(
            tool_icon("create_notebook"),
            Some(IconKind::CreateNotebook)
        ));
        assert!(matches!(
            tool_icon("connect_notebook"),
            Some(IconKind::OpenNotebook)
        ));
        assert!(matches!(tool_icon("execute_cell"), Some(IconKind::RunCell)));
        assert!(matches!(
            tool_icon("manage_dependencies"),
            Some(IconKind::ManageDependencies)
        ));
        assert!(tool_icon("not_a_registered_tool").is_none());
    }
}
