#[tokio::main]
async fn main() -> anyhow::Result<()> {
    runt_publish::run_from_env_args().await
}
