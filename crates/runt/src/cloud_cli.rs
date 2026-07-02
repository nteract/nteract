use std::time::Duration;

use anyhow::Result;
use clap::Subcommand;
use notebook_sync::SyncError;
use serde::Serialize;

#[derive(Subcommand)]
pub enum CloudCommands {
    /// Open a hosted cloud notebook through the local daemon bridge
    Open {
        /// Hosted notebook URL
        url: String,
        /// Operator label to append to the hosted actor identity
        #[arg(long)]
        operator: Option<String>,
        /// Keep the session alive for N seconds before exiting
        #[arg(long)]
        stay: Option<u64>,
        /// Output one JSON object
        #[arg(long)]
        json: bool,
    },
}

#[derive(Serialize)]
struct OpenSummary {
    notebook_id: String,
    actor_label: Option<String>,
    connection_scope: Option<String>,
    cell_count: usize,
}

pub async fn command(command: CloudCommands) -> Result<()> {
    match command {
        CloudCommands::Open {
            url,
            operator,
            stay,
            json,
        } => open(url, operator, stay, json).await,
    }
}

async fn open(url: String, operator: Option<String>, stay: Option<u64>, json: bool) -> Result<()> {
    let socket_path = runtimed_client::daemon_paths::get_socket_path();
    let result =
        match notebook_sync::connect::connect_open_hosted(socket_path, &url, operator).await {
            Ok(result) => result,
            Err(error) => exit_with_connect_error(error),
        };

    let summary = OpenSummary {
        notebook_id: result.info.notebook_id.clone(),
        actor_label: result.info.capabilities.actor_label.clone(),
        connection_scope: result.info.capabilities.connection_scope.clone(),
        cell_count: result.info.cell_count,
    };
    print_summary(&summary, json)?;

    if let Some(seconds) = stay {
        tokio::time::sleep(Duration::from_secs(seconds)).await;
    }

    Ok(())
}

fn print_summary(summary: &OpenSummary, json: bool) -> Result<()> {
    if json {
        println!("{}", serde_json::to_string(&summary)?);
    } else {
        println!("Daemon-local notebook ID: {}", summary.notebook_id);
        println!(
            "Actor label: {}",
            summary.actor_label.as_deref().unwrap_or("(none)")
        );
        println!(
            "Connection scope: {}",
            summary.connection_scope.as_deref().unwrap_or("(none)")
        );
        println!("Cell count: {}", summary.cell_count);
    }
    Ok(())
}

fn exit_with_connect_error(error: SyncError) -> ! {
    match error {
        SyncError::Protocol(message) => eprintln!("{message}"),
        other => eprintln!("{other}"),
    }
    std::process::exit(1);
}
