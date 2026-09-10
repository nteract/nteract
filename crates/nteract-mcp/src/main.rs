#[tokio::main]
async fn main() -> std::process::ExitCode {
    nteract_mcp::run_legacy().await
}
