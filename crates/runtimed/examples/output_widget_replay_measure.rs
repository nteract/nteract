use runtimed::output_widget_replay_measure::{
    measure_cached_replay_loop, measure_current_replay_loop, ReplayMeasurementConfig,
};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let counts = parse_counts(
        std::env::var("NTERACT_OUTPUT_WIDGET_REPLAY_COUNTS")
            .unwrap_or_else(|_| "10,100,500".to_string())
            .as_str(),
    );
    let payload_bytes = std::env::var("NTERACT_OUTPUT_WIDGET_REPLAY_PAYLOAD_BYTES")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(256);

    for output_count in counts {
        let config = ReplayMeasurementConfig {
            output_count,
            payload_bytes,
        };
        let current = measure_current_replay_loop(config).await?;
        println!(
            "{}",
            serde_json::to_string(&serde_json::json!({
                "strategy": "current",
                "metrics": current,
            }))?
        );

        let cached = measure_cached_replay_loop(config).await?;
        println!(
            "{}",
            serde_json::to_string(&serde_json::json!({
                "strategy": "cached",
                "metrics": cached,
            }))?
        );
    }

    Ok(())
}

fn parse_counts(raw: &str) -> Vec<usize> {
    raw.split(',')
        .filter_map(|part| part.trim().parse::<usize>().ok())
        .filter(|count| *count > 0)
        .collect()
}
