//! Resilient MCP proxy for `runt mcp`.
//!
//! Provides a reusable proxy core that spawns `runt mcp` as a child process,
//! forwards MCP tools/resources, and handles transparent restart on child death.
//!
//! Used by:
//! - `nteract-mcp` — shipped as a sidecar in the nteract app, inside the `.mcpb` Claude Desktop extension, and in the Claude Code plugin
//! - `mcp-supervisor` — dev environment MCP proxy with file watching and build management

// Allow `expect()` and `unwrap()` in tests
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]

pub mod child;
pub mod circuit_breaker;
pub mod proxy;
pub mod session;
pub mod tools;
pub mod version;

pub use proxy::{McpProxy, ProxyConfig};

/// MCP Apps extension identifier negotiated during the MCP initialize handshake.
pub const MCP_APPS_EXTENSION_ID: &str = "io.modelcontextprotocol/ui";

/// Capabilities shared by every client-facing nteract MCP proxy.
///
/// The proxy handles MCP App resources itself, so it must advertise this
/// capability rather than relying on the lazily-started child server's
/// initialize response, which is not visible to the upstream client.
pub fn mcp_apps_extension_capabilities() -> rmcp::model::ExtensionCapabilities {
    let mut extensions = rmcp::model::ExtensionCapabilities::new();
    extensions.insert(MCP_APPS_EXTENSION_ID.to_string(), serde_json::Map::new());
    extensions
}
