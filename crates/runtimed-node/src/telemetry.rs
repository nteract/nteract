//! Host-lifetime telemetry permission bindings. The Rust client owns the socket and lease.

use std::sync::Arc;

use napi::{bindgen_prelude::PromiseRaw, Env};
use napi_derive::napi;
use runtimed_client::telemetry::{
    HostTelemetryOptions, HostTelemetrySource, TelemetryRegistration as ClientRegistration,
};

use crate::error::to_napi_err;

#[napi(object)]
pub struct OpenTelemetryRegistrationOptions {
    /// Explicit daemon endpoint. Opening a registration never starts a daemon.
    pub socket_path: String,
    /// Stable product slug, not a user, window, session, or installation identifier.
    pub host_id: String,
    /// Only "app" and "mcp" are accepted.
    #[napi(ts_type = "'app' | 'mcp'")]
    pub source: String,
    /// Host permission only; daemon consent and emission gates still apply. Defaults to false.
    pub allowed: Option<bool>,
}

/// One connection-owned permission registration. Keep it alive while the host is active.
#[napi]
pub struct TelemetryRegistration {
    inner: Arc<ClientRegistration>,
}

#[napi]
impl TelemetryRegistration {
    /// Await the daemon's permission acknowledgment. Disconnected handles reject, never reconnect.
    #[napi]
    pub async fn update_permission(&self, allowed: bool) -> napi::Result<()> {
        self.inner
            .update_permission(allowed)
            .await
            .map_err(to_napi_err)
    }

    /// Fence queued grants synchronously, then await revocation acknowledgment.
    /// Idempotent after success; disconnection rejects.
    /// Without acknowledgment, remote revocation can take up to the 120-second lease expiry.
    #[napi(ts_return_type = "Promise<void>")]
    pub fn close<'env>(&self, env: &'env Env) -> napi::Result<PromiseRaw<'env, ()>> {
        self.inner.begin_close();
        // The future owns the registration even if the JS wrapper is collected.
        let inner = Arc::clone(&self.inner);
        env.spawn_future(async move { inner.close().await.map_err(to_napi_err) })
    }
}

/// Return null if host telemetry is unsupported or the capability probe is unavailable.
/// Permission defaults to denied.
/// The handle never reconnects; collecting an idle handle terminates its socket without awaiting revocation.
#[napi]
pub async fn open_telemetry_registration(
    options: OpenTelemetryRegistrationOptions,
) -> napi::Result<Option<TelemetryRegistration>> {
    let source = match options.source.as_str() {
        "app" => HostTelemetrySource::App,
        "mcp" => HostTelemetrySource::Mcp,
        _ => {
            return Err(napi::Error::new(
                napi::Status::InvalidArg,
                "source must be \"app\" or \"mcp\"",
            ));
        }
    };
    ClientRegistration::open(
        options.socket_path,
        HostTelemetryOptions {
            host_id: options.host_id,
            source,
            allowed: options.allowed.unwrap_or(false),
        },
    )
    .await
    .map(|registration| {
        registration.map(|inner| TelemetryRegistration {
            inner: Arc::new(inner),
        })
    })
    .map_err(to_napi_err)
}
