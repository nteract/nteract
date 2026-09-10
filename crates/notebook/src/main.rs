// Allow `expect()` and `unwrap()` in tests
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use clap::Parser;
use notebook::Runtime;
use std::path::PathBuf;

#[derive(Parser, Debug)]
#[command(name = "notebook", about = "Open notebooks")]
struct Args {
    /// Notebook file to open, or directory for a fresh untitled notebook
    path: Option<PathBuf>,

    /// Runtime for new notebooks (python, deno). Falls back to user settings if not specified.
    #[arg(long, short)]
    runtime: Option<Runtime>,

    /// Join an existing untitled notebook by its daemon ID (UUID)
    #[arg(long)]
    notebook_id: Option<String>,

    /// Seed a directory launch and consume its matching macOS document event once.
    #[arg(long, hide = true, conflicts_with_all = ["path", "notebook_id"])]
    open_directory: Option<PathBuf>,
}

fn main() {
    let args = Args::parse();

    if let Err(e) = notebook::run(
        args.path.clone(),
        args.runtime,
        args.notebook_id.clone(),
        args.open_directory.clone(),
    ) {
        // Show native error dialog before exiting
        let title = "Cannot Open Notebook";
        let message = match args.path.as_ref().or(args.open_directory.as_ref()) {
            Some(path) => format!("Failed to open '{}':\n\n{}", path.display(), e),
            None => format!("Failed to start notebook:\n\n{}", e),
        };

        rfd::MessageDialog::new()
            .set_title(title)
            .set_description(&message)
            .set_level(rfd::MessageLevel::Error)
            .show();

        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn directory_document_handoff_carries_explicit_path() {
        let args =
            Args::try_parse_from(["notebook", "--open-directory", "/project with spaces"]).unwrap();
        assert_eq!(
            args.open_directory,
            Some(PathBuf::from("/project with spaces"))
        );
        assert!(args.path.is_none());
        assert!(args.notebook_id.is_none());
    }

    #[test]
    fn directory_document_handoff_cannot_also_open_a_file_or_existing_notebook() {
        assert!(
            Args::try_parse_from(["notebook", "--open-directory", "/project", "saved.ipynb"])
                .is_err()
        );
        assert!(Args::try_parse_from([
            "notebook",
            "--open-directory",
            "/project",
            "--notebook-id",
            "existing-room"
        ])
        .is_err());
    }
}
