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

    if !daemon_heartbeat_eligible(&settings, now) {
        return;
    }

    let Some(platform) = nteract_telemetry::detect_platform() else {
        return;
    };
    let Some(arch) = nteract_telemetry::detect_arch() else {
        return;
    };

    let payload = nteract_telemetry::TelemetryPayload {
        host_id: None,
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

fn daemon_heartbeat_eligible(
    settings: &runtimed_client::settings_doc::SyncedSettings,
    now: u64,
) -> bool {
    nteract_telemetry::should_send_full(
        settings.telemetry_enabled,
        settings.onboarding_completed,
        settings.telemetry_consent_recorded,
        settings.telemetry_last_daemon_ping_at,
        now,
    )
}

#[cfg(test)]
mod tests {
    use super::daemon_heartbeat_eligible;
    use runtimed_client::settings_doc::SyncedSettings;

    #[test]
    fn heartbeat_requires_enabled_onboarded_and_recorded_consent() {
        for enabled in [false, true] {
            for onboarded in [false, true] {
                for consent_recorded in [false, true] {
                    let settings = SyncedSettings {
                        telemetry_enabled: enabled,
                        onboarding_completed: onboarded,
                        telemetry_consent_recorded: consent_recorded,
                        ..Default::default()
                    };
                    assert_eq!(
                        daemon_heartbeat_eligible(&settings, 1_700_000_000),
                        enabled && onboarded && consent_recorded,
                        "enabled={enabled}, onboarded={onboarded}, consent={consent_recorded}"
                    );
                }
            }
        }
    }

    #[test]
    fn heartbeat_uses_daemon_throttle_timestamp() {
        let now = 1_700_000_000;
        let mut settings = SyncedSettings {
            telemetry_enabled: true,
            onboarding_completed: true,
            telemetry_consent_recorded: true,
            telemetry_last_app_ping_at: Some(now),
            telemetry_last_mcp_ping_at: Some(now),
            ..Default::default()
        };

        assert!(daemon_heartbeat_eligible(&settings, now));
        for (last, eligible) in [
            (now + 1, false),
            (now, false),
            (now - 20 * 60 * 60 + 1, false),
            (now - 20 * 60 * 60, true),
        ] {
            settings.telemetry_last_daemon_ping_at = Some(last);
            assert_eq!(daemon_heartbeat_eligible(&settings, now), eligible);
        }
    }
}
