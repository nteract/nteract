#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::{path::Path, process::Command};

use notebook::iframe_shell::FRAME_HTML;

#[test]
fn typescript_generator_matches_checked_in_frame_html() {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let workspace_root = manifest_dir
        .parent()
        .and_then(Path::parent)
        .expect("notebook crate should live under crates/notebook");

    let script = r#"
const fs = require('fs');
let src = fs.readFileSync('src/components/isolated/frame-html.ts', 'utf8');
src = src
  .replace('export const FRAME_HTML =', 'const FRAME_HTML =')
  .replace('export function generateFrameHtml(): string {', 'function generateFrameHtml() {');
eval(src + '\nprocess.stdout.write(generateFrameHtml());');
"#;

    let output = match Command::new("node")
        .current_dir(workspace_root)
        .args(["-e", script])
        .output()
    {
        Ok(output) => output,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            eprintln!("skipping iframe shell parity test: node is not available");
            return;
        }
        Err(err) => panic!("failed to run node for iframe shell parity test: {err}"),
    };

    assert!(
        output.status.success(),
        "node failed while dumping generateFrameHtml():\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );

    assert_eq!(String::from_utf8(output.stdout).unwrap(), FRAME_HTML);
}
