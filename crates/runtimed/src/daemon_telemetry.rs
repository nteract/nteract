use std::sync::Arc;

use crate::daemon::Daemon;
use crate::task_supervisor::spawn_best_effort;

pub fn spawn_daemon_heartbeat(daemon: Arc<Daemon>) {
    spawn_best_effort("telemetry-heartbeat", async move {
        daemon_heartbeat_loop(daemon).await;
    });
}

async fn daemon_heartbeat_loop(daemon: Arc<Daemon>) {
    if nteract_telemetry::is_telemetry_suppressed() {
        tracing::debug!("[telemetry] suppressed, skipping daemon heartbeat loop");
        return;
    }

    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!("[telemetry] failed to build HTTP client: {e}");
            return;
        }
    };

    loop {
        try_send_daemon_heartbeat(&daemon, &client).await;
        tokio::time::sleep(std::time::Duration::from_secs(60 * 60)).await;
    }
}

async fn try_send_daemon_heartbeat(daemon: &Arc<Daemon>, client: &reqwest::Client) {
    let install_id_update = match daemon
        .update_settings_json(runtimed_client::settings_doc::ensure_install_id_in_settings)
        .await
    {
        Ok(update) => update,
        Err(e) => {
            tracing::warn!("[telemetry] failed to ensure install_id in settings.json: {e}");
            return;
        }
    };
    let (install_id, id_was_generated) = install_id_update.value;
    let install_id_was_persisted = install_id_update.changed;
    let settings = install_id_update.settings;

    if id_was_generated && install_id_was_persisted {
        tracing::info!("[telemetry] generated install_id");
    }

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    if !nteract_telemetry::should_send(
        settings.telemetry_enabled,
        settings.onboarding_completed,
        settings.telemetry_last_daemon_ping_at,
        now,
    ) {
        return;
    }

    let Some(platform) = nteract_telemetry::detect_platform() else {
        return;
    };
    let Some(arch) = nteract_telemetry::detect_arch() else {
        return;
    };

    let payload = nteract_telemetry::TelemetryPayload {
        install_id,
        source: "daemon".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        channel: nteract_telemetry::detect_channel().to_string(),
        platform: platform.to_string(),
        arch: arch.to_string(),
    };

    match nteract_telemetry::send_telemetry(client, &payload).await {
        Ok(()) => tracing::info!("[telemetry] sent daemon heartbeat"),
        Err(e) => tracing::warn!("[telemetry] daemon heartbeat failed: {e}"),
    }

    // Update timestamp and persist to disk so it survives daemon restarts
    if let Err(e) = daemon
        .update_settings_json(|settings| {
            settings.telemetry_last_daemon_ping_at = Some(now);
        })
        .await
    {
        tracing::warn!("[telemetry] failed to persist daemon heartbeat timestamp: {e}");
    }
}
