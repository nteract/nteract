use std::io::Read;
use std::path::PathBuf;

use anyhow::{anyhow, bail, Context, Result};
use clap::{Args, Subcommand};
use rmcp::model::{CallToolRequestParams, CallToolResult, RawContent, ResourceContents};
use serde_json::{Map, Value};

#[derive(Subcommand)]
pub enum NotebookCommands {
    /// List notebook tools exposed through the CLI bridge
    Tools {
        /// Output tool descriptors as JSON
        #[arg(long)]
        json: bool,
        /// Include dispatch-only read tools hidden from MCP advertisements
        #[arg(long)]
        all: bool,
    },
    /// Call a notebook tool without starting a full MCP server
    Call(Box<NotebookCallArgs>),
}

#[derive(Args)]
pub struct NotebookCallArgs {
    /// Tool name, for example create_cell, execute_cell, or manage_dependencies
    pub tool: String,

    /// JSON object to pass as the tool arguments
    #[arg(long, short = 'a', conflicts_with = "args_file")]
    pub args: Option<String>,

    /// Read the tool argument JSON object from a file, or '-' for stdin
    #[arg(long, conflicts_with = "args")]
    pub args_file: Option<PathBuf>,

    /// Attach to a local or hosted notebook target before calling the tool
    #[arg(
        long,
        value_name = "TARGET",
        conflicts_with_all = ["path", "notebook_id", "create"]
    )]
    pub target: Option<String>,

    /// Attach to a notebook path before calling the tool
    #[arg(
        long,
        value_name = "PATH",
        conflicts_with_all = ["target", "notebook_id", "create"]
    )]
    pub path: Option<PathBuf>,

    /// Attach to an active notebook ID before calling the tool
    #[arg(
        long,
        value_name = "UUID",
        conflicts_with_all = ["target", "path", "create"]
    )]
    pub notebook_id: Option<String>,

    /// Create an ephemeral notebook before calling the tool
    #[arg(long, conflicts_with_all = ["target", "path", "notebook_id"])]
    pub create: bool,

    /// Runtime for --create, usually python or deno
    #[arg(long, default_value = "python")]
    pub runtime: String,

    /// Working directory for --create
    #[arg(long, value_name = "DIR")]
    pub working_dir: Option<PathBuf>,

    /// Dependency to pre-install for --create; repeat for multiple packages
    #[arg(long = "dependency", value_name = "SPEC")]
    pub dependencies: Vec<String>,

    /// Package manager for --create: uv, conda, or pixi
    #[arg(long)]
    pub package_manager: Option<String>,

    /// Environment source mode for --create: auto, project, or notebook
    #[arg(long)]
    pub environment_mode: Option<String>,

    /// Create a persistent room for --create instead of the MCP-style ephemeral default
    #[arg(long)]
    pub persistent: bool,

    /// Explicit daemon socket path
    #[arg(long)]
    pub socket: Option<PathBuf>,

    /// Output the full MCP CallToolResult as JSON
    #[arg(long)]
    pub json: bool,
}

pub async fn command(command: NotebookCommands) -> Result<()> {
    match command {
        NotebookCommands::Tools { json, all } => list_tools(json, all),
        NotebookCommands::Call(args) => call_tool(*args).await,
    }
}

fn list_tools(json: bool, all: bool) -> Result<()> {
    let tools = if all {
        runt_mcp::tools::cli_discoverable_tools()
    } else {
        runt_mcp::tools::all_tools()
    };
    if json {
        println!("{}", serde_json::to_string_pretty(&tools)?);
        return Ok(());
    }

    for tool in tools {
        let description = tool.description.as_deref().unwrap_or("");
        if description.is_empty() {
            println!("{}", tool.name);
        } else {
            println!("{:<24} {}", tool.name, description);
        }
    }
    if !all {
        println!();
        println!(
            "Additional callable read tools: get_cell, get_all_cells. \
             Run `runt nb tools --all` to include dispatch-only read tools hidden from MCP advertisements."
        );
    }
    Ok(())
}

async fn call_tool(args: NotebookCallArgs) -> Result<()> {
    validate_create_options(&args)?;

    let socket_path = args
        .socket
        .clone()
        .unwrap_or_else(runtimed_client::daemon_paths::get_socket_path);
    let (blob_base_url, blob_store_path) =
        runtimed_client::daemon_paths::get_blob_paths_async(&socket_path).await;
    let daemon_info = runtimed_client::singleton::query_daemon_info(socket_path.clone()).await;
    let execution_store_path = daemon_info
        .as_ref()
        .and_then(|info| info.execution_store_dir.as_ref())
        .map(PathBuf::from);

    let server = runt_mcp::NteractMcp::new(socket_path, blob_base_url, blob_store_path)
        .with_execution_store_path(execution_store_path);
    server.set_peer_label("runt CLI").await;

    bootstrap_session(&server, &args).await?;

    let request = request(args.tool.clone(), read_arguments(&args)?)?;
    let result = runt_mcp::tools::dispatch(&server, &request)
        .await
        .map_err(|e| anyhow!("tool call failed: {e}"))?;

    print_result(&result, args.json)?;
    server.shutdown().await;
    if result.is_error.unwrap_or(false) {
        std::process::exit(1);
    }
    Ok(())
}

fn validate_create_options(args: &NotebookCallArgs) -> Result<()> {
    let create_options_used = args.working_dir.is_some()
        || !args.dependencies.is_empty()
        || args.package_manager.is_some()
        || args.environment_mode.is_some()
        || args.persistent;
    if create_options_used && !args.create {
        bail!(
            "--working-dir, --dependency, --package-manager, --environment-mode, \
             and --persistent only apply with --create"
        );
    }
    Ok(())
}

async fn bootstrap_session(server: &runt_mcp::NteractMcp, args: &NotebookCallArgs) -> Result<()> {
    let bootstrap = if let Some(target) = &args.target {
        Some(request(
            "connect_notebook",
            serde_json::json!({ "target": target }),
        )?)
    } else if let Some(path) = &args.path {
        Some(request(
            "connect_notebook",
            serde_json::json!({ "path": path.to_string_lossy() }),
        )?)
    } else if let Some(notebook_id) = &args.notebook_id {
        Some(request(
            "connect_notebook",
            serde_json::json!({ "notebook_id": notebook_id }),
        )?)
    } else if args.create {
        let mut obj = Map::new();
        obj.insert("runtime".to_string(), Value::String(args.runtime.clone()));
        obj.insert("ephemeral".to_string(), Value::Bool(!args.persistent));
        if let Some(path) = &args.working_dir {
            obj.insert(
                "working_dir".to_string(),
                Value::String(path.to_string_lossy().to_string()),
            );
        }
        if !args.dependencies.is_empty() {
            obj.insert(
                "dependencies".to_string(),
                Value::Array(
                    args.dependencies
                        .iter()
                        .cloned()
                        .map(Value::String)
                        .collect(),
                ),
            );
        }
        if let Some(package_manager) = &args.package_manager {
            obj.insert(
                "package_manager".to_string(),
                Value::String(package_manager.clone()),
            );
        }
        if let Some(environment_mode) = &args.environment_mode {
            obj.insert(
                "environment_mode".to_string(),
                Value::String(environment_mode.clone()),
            );
        }
        Some(request("create_notebook", Value::Object(obj))?)
    } else {
        None
    };

    if let Some(request) = bootstrap {
        let result = runt_mcp::tools::dispatch(server, &request)
            .await
            .map_err(|e| anyhow!("session bootstrap failed: {e}"))?;
        if result.is_error.unwrap_or(false) {
            bail!("session bootstrap failed: {}", result_text(&result));
        }
        if args.create && args.persistent {
            if let Some(notebook_id) = result_notebook_id(&result) {
                eprintln!("Created persistent notebook: {notebook_id}");
            }
        }
    }
    Ok(())
}

fn read_arguments(args: &NotebookCallArgs) -> Result<Value> {
    let Some(raw) = read_arguments_string(args)? else {
        return Ok(Value::Object(Map::new()));
    };

    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(Value::Object(Map::new()));
    }

    let value: Value = serde_json::from_str(trimmed).context("failed to parse --args as JSON")?;
    match value {
        Value::Object(_) | Value::Null => Ok(value),
        _ => bail!("tool arguments must be a JSON object"),
    }
}

fn read_arguments_string(args: &NotebookCallArgs) -> Result<Option<String>> {
    if let Some(raw) = &args.args {
        return Ok(Some(raw.clone()));
    }

    let Some(path) = &args.args_file else {
        return Ok(None);
    };

    if path.as_os_str() == "-" {
        let mut input = String::new();
        std::io::stdin()
            .read_to_string(&mut input)
            .context("failed to read tool arguments from stdin")?;
        Ok(Some(input))
    } else {
        std::fs::read_to_string(path)
            .with_context(|| format!("failed to read {}", path.display()))
            .map(Some)
    }
}

fn request(name: impl Into<String>, args: Value) -> Result<CallToolRequestParams> {
    let arguments = match args {
        Value::Object(map) => Some(map),
        Value::Null => None,
        _ => bail!("tool arguments must be a JSON object"),
    };

    let mut request = CallToolRequestParams::new(name.into());
    request.arguments = arguments;
    Ok(request)
}

fn print_result(result: &CallToolResult, json: bool) -> Result<()> {
    if json {
        println!("{}", serde_json::to_string_pretty(result)?);
        return Ok(());
    }

    let mut printed = false;
    for content in &result.content {
        match &content.raw {
            RawContent::Text(text) => {
                print_block(&text.text, &mut printed);
            }
            RawContent::ResourceLink(resource) => {
                print_block(&format!("Resource: {}", resource.uri), &mut printed);
            }
            RawContent::Resource(resource) => match &resource.resource {
                ResourceContents::TextResourceContents { uri, text, .. } => {
                    print_block(&format!("Resource: {uri}\n{text}"), &mut printed);
                }
                ResourceContents::BlobResourceContents { uri, .. } => {
                    print_block(&format!("Resource: {uri}"), &mut printed);
                }
            },
            RawContent::Image(image) => {
                print_block(
                    &format!(
                        "[image {}: {} base64 bytes]",
                        image.mime_type,
                        image.data.len()
                    ),
                    &mut printed,
                );
            }
            RawContent::Audio(audio) => {
                print_block(
                    &format!(
                        "[audio {}: {} base64 bytes]",
                        audio.mime_type,
                        audio.data.len()
                    ),
                    &mut printed,
                );
            }
        }
    }

    if !printed {
        if let Some(structured) = &result.structured_content {
            println!("{}", serde_json::to_string_pretty(structured)?);
        }
    }

    Ok(())
}

fn print_block(text: &str, printed: &mut bool) {
    if *printed {
        println!();
    }
    print!("{text}");
    if !text.ends_with('\n') {
        println!();
    }
    *printed = true;
}

fn result_text(result: &CallToolResult) -> String {
    let mut parts = Vec::new();
    for content in &result.content {
        match &content.raw {
            RawContent::Text(text) => parts.push(text.text.clone()),
            RawContent::ResourceLink(resource) => parts.push(format!("Resource: {}", resource.uri)),
            RawContent::Resource(resource) => match &resource.resource {
                ResourceContents::TextResourceContents { uri, text, .. } => {
                    parts.push(format!("Resource: {uri}\n{text}"));
                }
                ResourceContents::BlobResourceContents { uri, .. } => {
                    parts.push(format!("Resource: {uri}"));
                }
            },
            RawContent::Image(image) => parts.push(format!("[image {}]", image.mime_type)),
            RawContent::Audio(audio) => parts.push(format!("[audio {}]", audio.mime_type)),
        }
    }
    parts.join("\n")
}

fn result_notebook_id(result: &CallToolResult) -> Option<String> {
    if let Some(structured) = &result.structured_content {
        if let Some(notebook_id) = structured
            .get("notebook_id")
            .and_then(serde_json::Value::as_str)
        {
            return Some(notebook_id.to_string());
        }
    }

    for content in &result.content {
        let RawContent::Text(text) = &content.raw else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<Value>(&text.text) else {
            continue;
        };
        if let Some(notebook_id) = value.get("notebook_id").and_then(Value::as_str) {
            return Some(notebook_id.to_string());
        }
    }

    None
}
