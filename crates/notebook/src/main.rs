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

    /// Attach to an existing daemon notebook without creating or changing its context.
    #[arg(long, conflicts_with_all = ["path", "runtime", "notebook_id", "open_directory"])]
    attach_notebook_id: Option<uuid::Uuid>,

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
        args.attach_notebook_id,
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
    fn attach_only_cli_preserves_uuid_and_rejects_creation_selectors() {
        let id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        let args = Args::try_parse_from(["notebook", "--attach-notebook-id", id]).unwrap();
        assert_eq!(args.attach_notebook_id.unwrap().to_string(), id);
        assert!(args.notebook_id.is_none());
        for extra in [
            vec!["saved.ipynb"],
            vec!["--runtime", "deno"],
            vec!["--notebook-id", id],
            vec!["--open-directory", "/project"],
        ] {
            let mut argv = vec!["notebook", "--attach-notebook-id", id];
            argv.extend(extra);
            assert!(Args::try_parse_from(argv).is_err());
        }
        for invalid in ["not-a-uuid", "", "/project/saved.ipynb"] {
            assert!(Args::try_parse_from(["notebook", "--attach-notebook-id", invalid]).is_err());
        }
        // The legacy flag still carries a create/restore hint, not an attach intent.
        let legacy =
            Args::try_parse_from(["notebook", "--notebook-id", id, "--runtime", "deno"]).unwrap();
        assert_eq!(legacy.notebook_id.as_deref(), Some(id));
        assert!(legacy.attach_notebook_id.is_none());
        assert_eq!(legacy.runtime, Some(Runtime::Deno));
    }

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
