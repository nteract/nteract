# Production MCP renderer smoke

From the repository root:

```sh
pnpm install --frozen-lockfile
git lfs pull
pnpm --dir apps/mcp-app exec playwright install chromium
pnpm --dir apps/mcp-app test:smoke
```

The command ensures the production Sift WASM and renderer plugins, then always
builds the single-file MCP widget before running Chromium at 1280px and 390px.
Forcing the widget build avoids stale shared-code artifacts in a reused worktree. It needs the repository's
Rust/WASM build prerequisites. To rerun assertions against the same built bundle,
use `pnpm --dir apps/mcp-app exec playwright test`.

The test host uses the real `AppBridge`/`PostMessageTransport`, SDK Client/Server,
and `resources/read` protocol with an in-memory MCP transport. It supplies the
unmodified widget HTML embedded by the Rust MCP server, renderer JS/CSS/WASM,
and content-addressed fixture
blobs. Only the host adapter is compiled by the harness. The widget has a
`connect-src 'none'` CSP, and Playwright rejects direct HTTP requests from either
widget or output frames. No installed daemon, notebook, kernel, Codex settings,
or fixed localhost port is used. The ephemeral HTTP listener, SDK transports,
and temporary host build are closed in teardown, including setup failure.

Coverage includes Arrow sorting/filtering, Plotly and Vega-Lite, Markdown,
SVG/PNG/HTML, stdout, errors, missing resources, empty-result clearing/collapse,
source hiding, and sandbox/opaque-origin invariants. Screenshots and failure
traces go into `test-results/`; CI uploads them with the HTML report.

This is browser/fixture evidence, not actual Codex-host or live-kernel evidence.
The fixture resource handler does not exercise Rust daemon authorization or
catalog metadata. Those boundaries have separate tests in
`crates/runt-mcp/src/resources/output_resources.rs`:

```sh
cargo xtask artifacts ensure runtime,sift,renderer,mcp-widget
cargo test -p runt-mcp resources::output_resources
```

Keep fixtures deterministic and test observable behavior. Do not import renderer
source into this suite or replace the production widget with a Vite dev page.
