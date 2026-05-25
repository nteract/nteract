use runtimed::output_commit_measure::{
    measure_current_output_commit_loop, measure_ordered_worker_output_commit_model,
    OutputCommitKind, OutputCommitMeasurementConfig,
};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let counts = std::env::var("NTERACT_OUTPUT_COMMIT_COUNTS")
        .ok()
        .map(|value| {
            value
                .split(',')
                .filter_map(|part| part.trim().parse::<usize>().ok())
                .collect::<Vec<_>>()
        })
        .filter(|counts| !counts.is_empty())
        .unwrap_or_else(|| vec![100]);
    let payload_bytes = std::env::var("NTERACT_OUTPUT_COMMIT_PAYLOAD_BYTES")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(256);

    for kind in [
        OutputCommitKind::DisplayData,
        OutputCommitKind::ExecuteResult,
        OutputCommitKind::Error,
    ] {
        for output_count in counts.iter().copied() {
            let config = OutputCommitMeasurementConfig {
                output_count,
                payload_bytes,
                kind,
            };
            let current = measure_current_output_commit_loop(config).await?;
            println!("{}", serde_json::to_string(&current)?);

            let worker = measure_ordered_worker_output_commit_model(config).await?;
            println!("{}", serde_json::to_string(&worker)?);
        }
    }

    Ok(())
}
