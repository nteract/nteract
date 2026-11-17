use kernel_env::IpykernelDiagnostic;
use runtime_doc::KernelErrorReason;

pub(crate) fn classify_ipykernel_diagnostic(
    diagnostic: &IpykernelDiagnostic,
    env_source: &str,
) -> (KernelErrorReason, String) {
    match diagnostic {
        IpykernelDiagnostic::Present { .. } => (
            KernelErrorReason::MissingIpykernel,
            "ipykernel diagnostic unexpectedly succeeded".to_string(),
        ),
        IpykernelDiagnostic::Missing {
            python_path,
            purelib,
            import_error,
        } => (
            KernelErrorReason::DependencyCacheMissingIpykernel,
            format!(
                "ipykernel is not importable from the prepared {env_source} environment.\npython: {}\nsite-packages: {}{}",
                python_path.display(),
                purelib.display(),
                import_error
                    .as_ref()
                    .map(|err| format!("\nimport error: {err}"))
                    .unwrap_or_default()
            ),
        ),
        IpykernelDiagnostic::SitePackagesMismatch {
            python_path,
            purelib,
            import_error,
            candidates,
        } => {
            let found = candidates
                .iter()
                .map(|path| format!("  - {}", path.display()))
                .collect::<Vec<_>>()
                .join("\n");
            (
                KernelErrorReason::IpykernelSitePackagesMismatch,
                format!(
                    "ipykernel is installed outside the interpreter's importable site-packages path.\npython: {}\ninterpreter site-packages: {}{}\nfound ipykernel under:\n{}",
                    python_path.display(),
                    purelib.display(),
                    import_error
                        .as_ref()
                        .map(|err| format!("\nimport error: {err}"))
                        .unwrap_or_default(),
                    found
                ),
            )
        }
        IpykernelDiagnostic::InterpreterProbeFailed {
            python_path,
            message,
        } => (
            // An unsuccessful interpreter probe establishes no package absence.
            // Use the generic setup-failure banner with Retry, not cache repair.
            KernelErrorReason::EnvironmentPrepareFailed,
            format!(
                "Could not inspect ipykernel in the prepared {env_source} environment. This does not mean ipykernel is missing.\nRetry starting the kernel. If the probe keeps failing, check the interpreter and probe error below before changing installed packages.\npython: {}\nprobe error: {}",
                python_path.display(),
                message
            ),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn missing_ipykernel_maps_to_cache_missing_reason_with_probe_context() {
        let diagnostic = IpykernelDiagnostic::Missing {
            python_path: PathBuf::from("/tmp/env/bin/python"),
            purelib: PathBuf::from("/tmp/env/lib/python3.11/site-packages"),
            import_error: Some("ModuleNotFoundError: No module named ipykernel".to_string()),
        };

        let (reason, details) = classify_ipykernel_diagnostic(&diagnostic, "conda:inline");

        assert_eq!(reason, KernelErrorReason::DependencyCacheMissingIpykernel);
        assert!(details.contains("conda:inline"));
        assert!(details.contains("/tmp/env/bin/python"));
        assert!(details.contains("ModuleNotFoundError"));
    }

    #[test]
    fn interpreter_probe_failures_do_not_claim_ipykernel_is_missing() {
        for message in [
            "interpreter probe timed out after 10s",
            "Permission denied (os error 13)",
            "interpreter exited with status exit status: 1",
            "parse probe output: expected value at line 1 column 1",
        ] {
            let diagnostic = IpykernelDiagnostic::InterpreterProbeFailed {
                python_path: PathBuf::from("/tmp/env/bin/python"),
                message: message.to_string(),
            };

            let (reason, details) = classify_ipykernel_diagnostic(&diagnostic, "conda:inline");

            assert_eq!(reason, KernelErrorReason::EnvironmentPrepareFailed);
            assert!(details.contains("conda:inline"));
            assert!(details.contains("/tmp/env/bin/python"));
            assert!(details.contains(message));
            assert!(details.contains("Retry"));
            assert!(details.contains("does not mean ipykernel is missing"));
        }
    }

    #[test]
    fn sibling_site_packages_candidate_maps_to_abi_mismatch_reason() {
        let diagnostic = IpykernelDiagnostic::SitePackagesMismatch {
            python_path: PathBuf::from("/tmp/env/bin/python"),
            purelib: PathBuf::from("/tmp/env/lib/python3.14t/site-packages"),
            import_error: None,
            candidates: vec![PathBuf::from("/tmp/env/lib/python3.14/site-packages")],
        };

        let (reason, details) = classify_ipykernel_diagnostic(&diagnostic, "conda:inline");

        assert_eq!(reason, KernelErrorReason::IpykernelSitePackagesMismatch);
        assert!(details.contains("python3.14t"));
        assert!(details.contains("python3.14/site-packages"));
    }
}
