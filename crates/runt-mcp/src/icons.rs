//! Small monochrome MCP icons for resources, tools, and server metadata.

use base64::Engine as _;
use rmcp::model::{Icon, IconTheme};

const MIME_TYPE: &str = "image/png";
const SIZE: &str = "96x96";

#[derive(Debug, Clone, Copy)]
pub(crate) enum IconKind {
    Brand,
    CellCreate,
    CellDelete,
    CellEdit,
    CellList,
    CellMove,
    CellRead,
    Dependencies,
    Disconnect,
    GetResults,
    Interrupt,
    NotebookCreate,
    NotebookOpen,
    NotebookSave,
    Replace,
    ResourceCells,
    ResourceOutput,
    Restart,
    Run,
    RunAll,
}

pub(crate) fn icons(kind: IconKind) -> Vec<Icon> {
    vec![
        icon(light_bytes(kind), IconTheme::Light),
        icon(dark_bytes(kind), IconTheme::Dark),
    ]
}

pub(crate) fn tool_icon(name: &str) -> IconKind {
    match name {
        "list_active_notebooks" => IconKind::CellList,
        "connect_notebook" | "show_notebook" => IconKind::NotebookOpen,
        "create_notebook" => IconKind::NotebookCreate,
        "save_notebook" => IconKind::NotebookSave,
        "disconnect_notebook" => IconKind::Disconnect,
        "get_cell" => IconKind::CellRead,
        "get_all_cells" => IconKind::CellList,
        "create_cell" => IconKind::CellCreate,
        "set_cell" => IconKind::CellEdit,
        "delete_cell" => IconKind::CellDelete,
        "move_cell" => IconKind::CellMove,
        "execute_cell" => IconKind::Run,
        "run_all_cells" => IconKind::RunAll,
        "get_results" => IconKind::GetResults,
        "interrupt_kernel" => IconKind::Interrupt,
        "restart_kernel" => IconKind::Restart,
        "manage_dependencies" => IconKind::Dependencies,
        "replace_match" | "replace_regex" => IconKind::Replace,
        _ => IconKind::Brand,
    }
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
        IconKind::Brand => include_bytes!("../assets/icons/light/brand.png"),
        IconKind::CellCreate => include_bytes!("../assets/icons/light/cell-create.png"),
        IconKind::CellDelete => include_bytes!("../assets/icons/light/cell-delete.png"),
        IconKind::CellEdit => include_bytes!("../assets/icons/light/cell-edit.png"),
        IconKind::CellList => include_bytes!("../assets/icons/light/cell-list.png"),
        IconKind::CellMove => include_bytes!("../assets/icons/light/cell-move.png"),
        IconKind::CellRead => include_bytes!("../assets/icons/light/cell-read.png"),
        IconKind::Dependencies => include_bytes!("../assets/icons/light/dependencies.png"),
        IconKind::Disconnect => include_bytes!("../assets/icons/light/disconnect.png"),
        IconKind::GetResults => include_bytes!("../assets/icons/light/get-results.png"),
        IconKind::Interrupt => include_bytes!("../assets/icons/light/interrupt.png"),
        IconKind::NotebookCreate => include_bytes!("../assets/icons/light/notebook-create.png"),
        IconKind::NotebookOpen => include_bytes!("../assets/icons/light/notebook-open.png"),
        IconKind::NotebookSave => include_bytes!("../assets/icons/light/notebook-save.png"),
        IconKind::Replace => include_bytes!("../assets/icons/light/replace.png"),
        IconKind::ResourceCells => include_bytes!("../assets/icons/light/resource-cells.png"),
        IconKind::ResourceOutput => include_bytes!("../assets/icons/light/resource-output.png"),
        IconKind::Restart => include_bytes!("../assets/icons/light/restart.png"),
        IconKind::Run => include_bytes!("../assets/icons/light/run.png"),
        IconKind::RunAll => include_bytes!("../assets/icons/light/run-all.png"),
    }
}

fn dark_bytes(kind: IconKind) -> &'static [u8] {
    match kind {
        IconKind::Brand => include_bytes!("../assets/icons/dark/brand.png"),
        IconKind::CellCreate => include_bytes!("../assets/icons/dark/cell-create.png"),
        IconKind::CellDelete => include_bytes!("../assets/icons/dark/cell-delete.png"),
        IconKind::CellEdit => include_bytes!("../assets/icons/dark/cell-edit.png"),
        IconKind::CellList => include_bytes!("../assets/icons/dark/cell-list.png"),
        IconKind::CellMove => include_bytes!("../assets/icons/dark/cell-move.png"),
        IconKind::CellRead => include_bytes!("../assets/icons/dark/cell-read.png"),
        IconKind::Dependencies => include_bytes!("../assets/icons/dark/dependencies.png"),
        IconKind::Disconnect => include_bytes!("../assets/icons/dark/disconnect.png"),
        IconKind::GetResults => include_bytes!("../assets/icons/dark/get-results.png"),
        IconKind::Interrupt => include_bytes!("../assets/icons/dark/interrupt.png"),
        IconKind::NotebookCreate => include_bytes!("../assets/icons/dark/notebook-create.png"),
        IconKind::NotebookOpen => include_bytes!("../assets/icons/dark/notebook-open.png"),
        IconKind::NotebookSave => include_bytes!("../assets/icons/dark/notebook-save.png"),
        IconKind::Replace => include_bytes!("../assets/icons/dark/replace.png"),
        IconKind::ResourceCells => include_bytes!("../assets/icons/dark/resource-cells.png"),
        IconKind::ResourceOutput => include_bytes!("../assets/icons/dark/resource-output.png"),
        IconKind::Restart => include_bytes!("../assets/icons/dark/restart.png"),
        IconKind::Run => include_bytes!("../assets/icons/dark/run.png"),
        IconKind::RunAll => include_bytes!("../assets/icons/dark/run-all.png"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn icons_include_light_and_dark_png_data_uris() {
        let icons = icons(IconKind::Brand);
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
        assert!(matches!(tool_icon("create_cell"), IconKind::CellCreate));
        assert!(matches!(
            tool_icon("create_notebook"),
            IconKind::NotebookCreate
        ));
        assert!(matches!(
            tool_icon("connect_notebook"),
            IconKind::NotebookOpen
        ));
        assert!(matches!(tool_icon("execute_cell"), IconKind::Run));
        assert!(matches!(
            tool_icon("manage_dependencies"),
            IconKind::Dependencies
        ));
    }
}
