use std::{
    collections::{BTreeMap, HashSet},
    path::PathBuf,
    process::Stdio,
    time::Duration,
};

use anyhow::{Context, Result};
use clap::Parser;
use jupyter_protocol::{
    connection_info::Transport, ConnectionInfo, ExecuteRequest, ExecutionState, JupyterMessage,
    JupyterMessageContent, MediaType, Status, Stdio as JupyterStdio,
};
use jupyter_zmq_client::{
    create_client_iopub_connection, create_client_shell_connection_with_identity,
    find_kernelspec_with_jupyter_paths, peek_ports_with_listeners, peer_identity_for_session,
    runtime_dir,
};
use petname::petname;
use serde::Serialize;
use tokio::{process::Child, time::Instant};
use uuid::Uuid;

#[derive(Parser, Debug)]
#[command(about = "Stress raw Jupyter IOPub display traffic without runtimed or the notebook UI")]
struct Args {
    /// Comma-separated display counts to execute in order.
    #[arg(long, default_value = "100,500,1000")]
    counts: String,

    /// Kernel name from Jupyter kernelspec discovery.
    #[arg(long, default_value = "python3")]
    kernel: String,

    /// Raw command to launch the kernel. Use {connection_file} as the placeholder.
    #[arg(long)]
    cmd: Option<String>,

    /// Per-execution timeout.
    #[arg(long, default_value_t = 180)]
    timeout_secs: u64,

    /// Extra delay after connecting IOPub before sending the first execute request.
    #[arg(long, default_value_t = 500)]
    subscribe_delay_ms: u64,
}

struct LaunchedKernel {
    kernel_name: String,
    session_id: String,
    connection_info: ConnectionInfo,
    connection_file: PathBuf,
    child: Child,
}

#[derive(Serialize)]
struct StressResult {
    kernel: String,
    count: usize,
    success: bool,
    timed_out: bool,
    ordered: bool,
    display_count: usize,
    stream_count: usize,
    stdout_bytes: usize,
    sentinel_seen: bool,
    shell_execute_reply_seen: bool,
    shell_reply_status: Option<String>,
    status_busy_seen: bool,
    status_idle_seen: bool,
    iopub_messages: usize,
    foreign_iopub_messages: usize,
    shell_messages: usize,
    foreign_shell_messages: usize,
    message_counts: BTreeMap<String, usize>,
    first_display_ms: Option<u128>,
    last_display_ms: Option<u128>,
    shell_reply_ms: Option<u128>,
    idle_ms: Option<u128>,
    elapsed_ms: u128,
    missing: Vec<usize>,
    duplicates: Vec<usize>,
    first_labels: Vec<usize>,
    last_labels: Vec<usize>,
    errors: Vec<String>,
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    let counts = parse_counts(&args.counts)?;

    let mut kernel = launch_kernel(&args).await?;
    let identity = peer_identity_for_session(&kernel.session_id)?;
    let shell = create_client_shell_connection_with_identity(
        &kernel.connection_info,
        &kernel.session_id,
        identity,
    )
    .await?;
    let (mut shell_writer, mut shell_reader) = shell.split();
    let mut iopub =
        create_client_iopub_connection(&kernel.connection_info, "", &kernel.session_id).await?;

    tokio::time::sleep(Duration::from_millis(args.subscribe_delay_ms)).await;

    for count in counts {
        let result = run_once(
            &kernel.kernel_name,
            count,
            Duration::from_secs(args.timeout_secs),
            &mut shell_writer,
            &mut shell_reader,
            &mut iopub,
        )
        .await?;
        let timed_out = result.timed_out;
        println!("{}", serde_json::to_string(&result)?);
        if timed_out {
            break;
        }
    }

    let _ = tokio::fs::remove_file(&kernel.connection_file).await;
    let _ = kernel.child.kill().await;
    Ok(())
}

async fn launch_kernel(args: &Args) -> Result<LaunchedKernel> {
    let kernel_id = petname(2, "-").context("failed to generate kernel id")?;
    let session_id = Uuid::new_v4().to_string();
    let key = Uuid::new_v4().to_string();
    let ip = std::net::IpAddr::V4(std::net::Ipv4Addr::new(127, 0, 0, 1));
    let (ports, listeners) = peek_ports_with_listeners(ip, 5).await?;
    let kernel_name = args
        .cmd
        .as_ref()
        .map_or(args.kernel.clone(), |_| "cmd".to_string());
    let connection_info = ConnectionInfo {
        transport: Transport::TCP,
        ip: ip.to_string(),
        stdin_port: ports[0],
        control_port: ports[1],
        hb_port: ports[2],
        shell_port: ports[3],
        iopub_port: ports[4],
        signature_scheme: "hmac-sha256".to_string(),
        key,
        kernel_name: Some(kernel_name.clone()),
    };

    let runtime_dir = runtime_dir();
    tokio::fs::create_dir_all(&runtime_dir).await?;
    let connection_file = runtime_dir.join(format!("raw-iopub-stress-{kernel_id}.json"));
    tokio::fs::write(&connection_file, serde_json::to_string(&connection_info)?).await?;

    let mut command = if let Some(cmd) = &args.cmd {
        let command_line = cmd.replace(
            "{connection_file}",
            connection_file
                .to_str()
                .context("connection file path is not valid UTF-8")?,
        );
        shell_command(&command_line)
    } else {
        let kernelspec = find_kernelspec_with_jupyter_paths(&args.kernel).await?;
        kernelspec.command(&connection_file, None, None)?
    };

    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Ok(cwd) = std::env::current_dir() {
        command.current_dir(cwd);
    }

    let child = command.spawn().context("failed to spawn kernel")?;
    drop(listeners);
    tokio::time::sleep(Duration::from_millis(500)).await;

    Ok(LaunchedKernel {
        kernel_name,
        session_id,
        connection_info,
        connection_file,
        child,
    })
}

fn shell_command(command_line: &str) -> tokio::process::Command {
    if cfg!(windows) {
        let mut command = tokio::process::Command::new("cmd");
        command.args(["/C", command_line]);
        command
    } else {
        let mut command = tokio::process::Command::new("sh");
        command.args(["-c", command_line]);
        command
    }
}

async fn run_once<ShellSend, ShellRecv, IoPubRecv>(
    kernel_name: &str,
    count: usize,
    timeout: Duration,
    shell_writer: &mut jupyter_zmq_client::Connection<ShellSend>,
    shell_reader: &mut jupyter_zmq_client::Connection<ShellRecv>,
    iopub: &mut jupyter_zmq_client::Connection<IoPubRecv>,
) -> Result<StressResult>
where
    ShellSend: zeromq::SocketSend,
    ShellRecv: zeromq::SocketRecv,
    IoPubRecv: zeromq::SocketRecv,
{
    let code = display_stress_code(count);
    let message: JupyterMessage = ExecuteRequest::new(code).into();
    let message_id = message.header.msg_id.clone();

    let start = Instant::now();
    let deadline = start + timeout;
    let mut timeout_sleep = Box::pin(tokio::time::sleep_until(deadline));

    let mut labels = Vec::with_capacity(count);
    let mut display_count = 0;
    let mut stream_count = 0;
    let mut stdout_bytes = 0;
    let mut sentinel_seen = false;
    let mut shell_execute_reply_seen = false;
    let mut shell_reply_status = None;
    let mut status_busy_seen = false;
    let mut status_idle_seen = false;
    let mut iopub_messages = 0;
    let mut foreign_iopub_messages = 0;
    let mut shell_messages = 0;
    let mut foreign_shell_messages = 0;
    let mut message_counts = BTreeMap::new();
    let mut first_display_ms = None;
    let mut last_display_ms = None;
    let mut shell_reply_ms = None;
    let mut idle_ms = None;
    let mut errors = Vec::new();
    let mut timed_out = false;

    shell_writer.send(message).await?;

    while !(status_idle_seen && shell_execute_reply_seen) {
        tokio::select! {
            _ = &mut timeout_sleep => {
                timed_out = true;
                break;
            }
            result = iopub.read() => {
                let msg = result?;
                let is_ours = parent_matches(&msg, &message_id);
                if !is_ours {
                    foreign_iopub_messages += 1;
                    continue;
                }

                iopub_messages += 1;
                *message_counts.entry(msg.header.msg_type.clone()).or_insert(0) += 1;

                match msg.content {
                    JupyterMessageContent::DisplayData(data) => {
                        display_count += 1;
                        let elapsed = start.elapsed().as_millis();
                        first_display_ms.get_or_insert(elapsed);
                        last_display_ms = Some(elapsed);
                        if let Some(label) = data.data.content.iter().find_map(plain_text_label) {
                            labels.push(label);
                        }
                    }
                    JupyterMessageContent::StreamContent(stream) => {
                        stream_count += 1;
                        match stream.name {
                            JupyterStdio::Stdout => {
                                stdout_bytes += stream.text.len();
                                if stream.text.contains(&sentinel(count)) {
                                    sentinel_seen = true;
                                }
                            }
                            JupyterStdio::Stderr => {
                                if !stream.text.trim().is_empty() {
                                    errors.push(format!("stderr: {}", stream.text.trim()));
                                }
                            }
                        }
                    }
                    JupyterMessageContent::Status(Status { execution_state }) => match execution_state {
                        ExecutionState::Busy => status_busy_seen = true,
                        ExecutionState::Idle => {
                            status_idle_seen = true;
                            idle_ms = Some(start.elapsed().as_millis());
                        }
                        other => {
                            errors.push(format!("status: {}", other.as_str()));
                        }
                    },
                    JupyterMessageContent::ErrorOutput(error) => {
                        errors.push(format!("{}: {}", error.ename, error.evalue));
                    }
                    _ => {}
                }
            }
            result = shell_reader.read() => {
                let msg = result?;
                let is_ours = parent_matches(&msg, &message_id);
                if !is_ours {
                    foreign_shell_messages += 1;
                    continue;
                }

                shell_messages += 1;
                if let JupyterMessageContent::ExecuteReply(reply) = msg.content {
                    shell_execute_reply_seen = true;
                    shell_reply_status = Some(format!("{:?}", reply.status));
                    shell_reply_ms = Some(start.elapsed().as_millis());
                }
            }
        }
    }

    let (ordered, missing, duplicates) = sequence_diagnostics(&labels, count);
    let success = !timed_out
        && ordered
        && display_count == count
        && labels.len() == count
        && sentinel_seen
        && shell_execute_reply_seen
        && status_idle_seen
        && errors.is_empty();

    Ok(StressResult {
        kernel: kernel_name.to_string(),
        count,
        success,
        timed_out,
        ordered,
        display_count,
        stream_count,
        stdout_bytes,
        sentinel_seen,
        shell_execute_reply_seen,
        shell_reply_status,
        status_busy_seen,
        status_idle_seen,
        iopub_messages,
        foreign_iopub_messages,
        shell_messages,
        foreign_shell_messages,
        message_counts,
        first_display_ms,
        last_display_ms,
        shell_reply_ms,
        idle_ms,
        elapsed_ms: start.elapsed().as_millis(),
        missing,
        duplicates,
        first_labels: labels.iter().copied().take(10).collect(),
        last_labels: labels
            .iter()
            .copied()
            .rev()
            .take(10)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect(),
        errors,
    })
}

fn parent_matches(msg: &JupyterMessage, message_id: &str) -> bool {
    msg.parent_header
        .as_ref()
        .map(|header| header.msg_id.as_str())
        == Some(message_id)
}

fn plain_text_label(media: &MediaType) -> Option<usize> {
    let MediaType::Plain(text) = media else {
        return None;
    };
    text.trim().strip_prefix("display ")?.parse().ok()
}

fn sentinel(count: usize) -> String {
    format!("RAW_IOPUB_SENTINEL count={count}")
}

fn display_stress_code(count: usize) -> String {
    format!(
        r#"
from IPython.display import display
import time

N = {count}
start = time.perf_counter()
for i in range(N):
    display({{"text/plain": f"display {{i:06d}}"}}, raw=True)
elapsed = time.perf_counter() - start
print("{sentinel} elapsed={{:.6f}}".format(elapsed))
"#,
        count = count,
        sentinel = sentinel(count),
    )
}

fn parse_counts(counts: &str) -> Result<Vec<usize>> {
    let parsed = counts
        .split(',')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .map(str::parse::<usize>)
        .collect::<std::result::Result<Vec<_>, _>>()?;
    anyhow::ensure!(!parsed.is_empty(), "at least one count is required");
    Ok(parsed)
}

fn sequence_diagnostics(labels: &[usize], expected: usize) -> (bool, Vec<usize>, Vec<usize>) {
    let ordered = labels.iter().copied().eq(0..expected);
    let seen: HashSet<usize> = labels.iter().copied().collect();
    let missing = (0..expected)
        .filter(|index| !seen.contains(index))
        .take(20)
        .collect();

    let mut seen_once = HashSet::new();
    let mut duplicate_set = HashSet::new();
    let mut duplicates = Vec::new();
    for label in labels {
        if !seen_once.insert(*label) && duplicate_set.insert(*label) {
            duplicates.push(*label);
            if duplicates.len() == 20 {
                break;
            }
        }
    }

    (ordered, missing, duplicates)
}
