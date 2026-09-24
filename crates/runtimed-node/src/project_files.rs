//! Explicit filesystem operations for the local Node host process.

use kernel_env::environment_yml::EnvironmentYmlSpec;
use napi::Result;
use napi_derive::napi;
use std::path::PathBuf;

use crate::error::to_napi_err;

/// Options for the local host's explicit manifest creation request.
#[napi(object)]
pub struct InitializeEnvironmentYmlOptions {
    /// An existing absolute directory the host is authorized to write.
    pub directory: String,
    /// Optional environment name: letters, numbers, '.', '_' and '-'.
    pub name: Option<String>,
    /// Conda match specs; pip subsections are not supported by this initializer.
    pub dependencies: Vec<String>,
    /// Optional Python version constraint, e.g. "3.12" or ">=3.11,<3.13".
    pub python: Option<String>,
    /// At least one channel, in priority order. No channels are inferred.
    pub channels: Vec<String>,
}

/// Create environment.yml without overwriting an existing file or symlink.
///
/// This uses the local Node process's filesystem authority. It does not contact
/// the daemon, install packages, approve trust, or launch/change a kernel.
/// Returns the absolute path of the newly created manifest.
#[napi]
pub async fn initialize_environment_yml(
    options: InitializeEnvironmentYmlOptions,
) -> Result<String> {
    tokio::task::spawn_blocking(move || {
        let path = kernel_env::environment_yml::initialize_environment_yml(
            &PathBuf::from(options.directory),
            &EnvironmentYmlSpec {
                name: options.name,
                dependencies: options.dependencies,
                python: options.python,
                channels: options.channels,
            },
        )
        .map_err(to_napi_err)?;
        Ok(path.to_string_lossy().into_owned())
    })
    .await
    .map_err(to_napi_err)?
}
