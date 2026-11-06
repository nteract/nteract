//! Embedded Python warmup script and command builder.
//!
//! The prewarm Python package at `python/prewarm/src/prewarm/__init__.py`
//! is the single source of truth for warmup logic. This module embeds it
//! at compile time via `include_str!` so the daemon can run it in any
//! environment without pip-installing the package first.
//!
//! # Usage
//!
//! ```ignore
//! use kernel_env::warmup;
//!
//! // Build a warmup script for a conda environment
//! let script = warmup::build_warmup_command(&["matplotlib".to_string()], true);
//!
//! // Run: python -c <script>
//! ```

/// The prewarm Python source, embedded at compile time.
///
/// This is the full `__init__.py` from `python/prewarm/src/prewarm/`.
/// It contains `build_warmup_script()` which generates a self-contained
/// Python script string — no prewarm import needed at runtime.
pub const PREWARM_SOURCE: &str = include_str!("../../../python/prewarm/src/prewarm/__init__.py");

/// Build a complete Python script that can be passed to `python -c`.
///
/// The generated script:
/// 1. Defines the prewarm functions (from embedded source)
/// 2. Calls `build_warmup_script()` with the given arguments
/// 3. `exec()`s the result
///
/// This avoids the package needing to be installed — the entire prewarm
/// module is inlined into the script.
///
/// The script only imports modules. It never runs `compileall` over
/// site-packages: that wrote hundreds of MB of `.pyc` per env and often hit
/// the warmup timeout. Python compiles what a kernel actually imports.
pub fn build_warmup_command(extra_modules: &[String], include_conda: bool) -> String {
    let modules_py: Vec<String> = extra_modules.iter().map(|m| format!("{m:?}")).collect();
    let modules_list = format!("[{}]", modules_py.join(", "));

    // We exec the embedded source to define all functions, then call
    // build_warmup_script() and exec the result.
    format!(
        r#"exec({prewarm_source:?})
_script = build_warmup_script({modules}, include_conda={include_conda}, site_packages=None)
exec(_script)"#,
        prewarm_source = PREWARM_SOURCE,
        modules = modules_list,
        include_conda = if include_conda { "True" } else { "False" },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_prewarm_source_is_embedded() {
        // Verify the include_str! resolved correctly
        assert!(PREWARM_SOURCE.contains("def warm("));
        assert!(PREWARM_SOURCE.contains("def build_warmup_script("));
        assert!(PREWARM_SOURCE.contains("BASE_MODULES"));
    }

    #[test]
    fn test_build_warmup_command_basic() {
        let cmd = build_warmup_command(&[], false);
        assert!(cmd.contains("exec("));
        assert!(cmd.contains("build_warmup_script("));
        assert!(cmd.contains("include_conda=False"));
    }

    #[test]
    fn test_build_warmup_command_with_conda() {
        let cmd = build_warmup_command(&[], true);
        assert!(cmd.contains("include_conda=True"));
    }

    #[test]
    fn test_build_warmup_command_with_modules() {
        let modules = vec!["numpy".to_string(), "pandas".to_string()];
        let cmd = build_warmup_command(&modules, false);
        assert!(cmd.contains("numpy"));
        assert!(cmd.contains("pandas"));
    }

    #[test]
    fn test_build_warmup_command_never_compiles_site_packages() {
        let cmd = build_warmup_command(&["numpy".to_string()], true);
        // The embedded source still defines the compileall helper for the
        // CLI; the generated call must never ask for it.
        assert!(cmd.contains(
            r#"_script = build_warmup_script(["numpy"], include_conda=True, site_packages=None)"#
        ));
    }
}
