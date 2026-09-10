// The installed public command is `nteract`. Keep the physical sidecar name
// distinct from the desktop app's `nteract` executable in the same bundle.
fn main() -> anyhow::Result<()> {
    runt::run(runt::EntryPoint::Nteract)
}
