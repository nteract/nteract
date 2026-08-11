use std::path::PathBuf;

fn main() {
    napi_build::setup();
    let out_dir = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR is required"));
    build_metadata::emit_git_rerun_hints();
    build_metadata::write_git_hash(&out_dir);
}
