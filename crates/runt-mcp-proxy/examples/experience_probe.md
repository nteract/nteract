# Measuring MCP host behavior

This fixture serves one synthetic resource and three tools. It never attaches to a daemon or notebook. It supports both initialize-based MCP clients and native `2026-07-28` requests. Use it to measure an installed host before claiming that protocol support improves the agent's experience.

With the pinned rmcp 3.2 server launcher, native clients must send `server/discover` before a request that sends notifications or remains open. Its first-request path awaits the handler before starting the peer message loop, so opening with `subscriptions/listen` stalls before acknowledgment. The native smoke test deliberately covers discovery followed by listen, without initialize. Fixing this launcher limitation is required before native production support can be advertised.

Build with `cargo build --locked -p runt-mcp-proxy --example experience_probe`. Configure `target/debug/examples/experience_probe` as a temporary stdio MCP server, with an absolute path to a **new** JSONL file as its only argument. The file records incoming and outgoing wire messages with timestamps. Existing files are refused to keep runs separate. Keep this evidence local: client identity and the fixture's tool arguments are recorded.

Run each experiment in a fresh host session and retain its transcript alongside the JSONL file. Record the host version, model, protocol version, and whether this was the desktop or CLI host. CLI results do not establish desktop behavior.

## Resource refresh

Ask the agent to read `probe://notebook`, call `schedule_change`, then call `long_job`. Ask it for the current resource value after the job, without repeatedly polling. `schedule_change` returns the baseline and changes the resource three seconds later. The changed value is a random marker absent from tool descriptions and the job receipt.

Check the evidence separately:

- Did the host issue `resources/subscribe` or `subscriptions/listen` for the resource?
- Did the fixture send `notifications/resources/updated` after the change?
- Did the host re-read the resource? Was the request prompted by an agent tool call or host behavior?
- Did the changed marker reach the model's answer?
- Did a notification resume an idle agent, or did it only arrive during an already active turn?

A notification in the wire log alone proves delivery to the host transport. It does not prove a UI update, context refresh, or agent wake-up. If the host doesn't expose resources, record that limitation instead of introducing a resource-reading tool that changes the experiment.

## Bounded wait fallback

In a fresh session, call `schedule_change`, then call `wait_for_change` once with the returned revision in `after`. It should return the changed marker after about three seconds. The maximum wait is 25 seconds. This path tests whether a normal tool result can deliver useful context without a model polling loop.

## Progress and cancellation

Call `long_job`. It takes eight seconds and emits progress at startup and five seconds, only if the host supplies a progress token. Record the presence and token correlation of wire notifications separately from visible host progress.

For cancellation, cancel the pending call through the host after its initial progress. The fixture job continues. After eight seconds, a resource read reports `completed_jobs: 1`. This models canceling observation without interrupting shared notebook execution. Use a fresh session for each attempt.

The fixture's unit tests verify legacy notifications, native subscription correlation, and job survival after request cancellation with an independent raw JSON-RPC client. They do not substitute for the host experiments.
