//! Canonical display names for known MCP clients.

#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]

use std::borrow::Cow;

/// Canonical display names for known MCP client implementation names.
///
/// MCP clients often send a machine-oriented `Implementation.name` without a
/// human-readable `Implementation.title`. Keep this table as the single
/// fallback source for turning those raw names into user-facing labels.
pub const CLIENT_DISPLAY_NAME_MAPPINGS: &[(&str, &str)] = &[
    ("@librechat/api-client", "LibreChat"),
    ("@n8n/n8n-nodes-langchain.mcpClientTool", "N8N MCP Client"),
    ("Alpic", "Alpic"),
    ("amp-mcp-client", "AmpCode"),
    ("Anthropic/API", "Anthropic API"),
    ("Anthropic/ClaudeAI", "Claude.ai"),
    ("antigravity-client", "Google Antigravity"),
    ("apify-mcp-client", "Apify MCP Client"),
    ("arcade", "Arcade"),
    ("ChatGPT", "ChatGPT"),
    ("Cherry Studio", "Cherry Studio"),
    ("claude-ai", "Claude Desktop"),
    ("claude-desktop", "Claude Desktop"),
    ("claude-code", "Claude Code"),
    ("Cline", "Cline"),
    ("CodeRabbit", "CodeRabbit"),
    ("codex-mcp-client", "OpenAI Codex"),
    ("codex-cli", "OpenAI Codex"),
    ("com.raycast.macos", "Raycast"),
    ("continue-cli-client", "Continue CLI Client"),
    ("continue-client", "Continue"),
    ("crush", "Crush"),
    ("cursor-vscode", "Cursor"),
    ("Cursor", "Cursor"),
    ("cursor", "Cursor"),
    ("docker-mcp-gateway", "Docker MCP Gateway"),
    ("dust-mcp-client", "Dust"),
    ("emacs", "Emacs"),
    ("Eglot", "Emacs"),
    ("etherassist-mcp-client", "EtherAssist"),
    ("example-client", "Example Client"),
    ("factory-cli", "Factory CLI"),
    ("gemini-cli", "Gemini CLI"),
    ("gemini-cli-mcp-client", "Gemini CLI"),
    ("gitguardian", "GitGuardian"),
    ("github-copilot-developer", "GitHub Copilot CLI"),
    ("goose", "Goose"),
    ("helix", "Helix"),
    ("Jan-Streamable-Client", "Jan AI"),
    ("jetbrains-ai-assistant-client", "JetBrains AI Assistant"),
    ("JetBrains-IU-copilot-intellij", "JetBrains AI Assistant"),
    (
        "JetBrains-IU/copilot-intellij",
        "GitHub Copilot for IntelliJ",
    ),
    (
        "JetBrains-JBC-copilot-intellij",
        "JetBrains AI Assistant with GitHub Copilot",
    ),
    ("Kilo-Code", "Kilo Code"),
    ("lobehub-mcp-client", "LobeHub"),
    ("make-app-mcp-client", "Make MCP Client"),
    ("mcp", "Python SDK default"),
    ("mcp-python-client", "Python SDK default"),
    ("mcp-cli", "MCP CLI"),
    ("mcp-cli-client", "MCP CLI"),
    ("mcs", "Copilot Studio"),
    ("mise", "Mise"),
    ("Mistral", "Mistral AI: Le Chat"),
    ("my-awesome-client", "Go SDK example"),
    ("openai-mcp", "OpenAI/ChatGPT MCP connector"),
    ("opencode", "Opencode"),
    ("Postman-Client", "Postman"),
    ("q-cli", "Amazon Q CLI"),
    ("Q-DEV-CLI", "Amazon Q CLI"),
    ("replit-workspace", "Replit"),
    ("Roo Code", "Roo Code"),
    ("Roo-Code", "Roo Code"),
    ("spring-ai-mcp-client", "Spring AI MCP Client"),
    ("test-client", "Smithery test & playground"),
    ("Trae", "Trae"),
    ("Visual Studio Code", "Visual Studio Code"),
    ("Visual Studio Code - Insiders", "Visual Studio Code"),
    ("warp", "Warp"),
    ("Windsurf", "Windsurf"),
    ("windsurf-client", "Windsurf Editor"),
    ("Xcode-copilot-xcode", "GitHub Copilot for Xcode"),
    ("Zed", "Zed"),
    ("zed", "Zed"),
];

/// Return the canonical display name for a known raw MCP client name or alias.
pub fn canonical_display_name(client_name: &str) -> Option<&'static str> {
    let client_name = client_name.trim();
    if client_name.is_empty() {
        return None;
    }

    CLIENT_DISPLAY_NAME_MAPPINGS
        .iter()
        .find_map(|(raw_name, display_name)| (*raw_name == client_name).then_some(*display_name))
}

/// Resolve a user-facing MCP client display name.
///
/// Client-provided titles are already the display-name path, so they win. When
/// a title is missing, known raw implementation names and aliases map to their
/// official names before falling back to the trimmed raw name.
pub fn display_name<'a>(
    client_name: &'a str,
    client_title: Option<&'a str>,
) -> Option<Cow<'a, str>> {
    if let Some(title) = client_title
        .map(str::trim)
        .filter(|title| !title.is_empty())
    {
        return Some(Cow::Borrowed(title));
    }

    if let Some(display_name) = canonical_display_name(client_name) {
        return Some(Cow::Borrowed(display_name));
    }

    let client_name = client_name.trim();
    if client_name.is_empty() {
        None
    } else {
        Some(Cow::Borrowed(client_name))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_display_name_maps_known_clients_and_aliases() {
        assert_eq!(canonical_display_name("claude-ai"), Some("Claude Desktop"));
        assert_eq!(
            canonical_display_name("claude-desktop"),
            Some("Claude Desktop")
        );
        assert_eq!(canonical_display_name("cursor-vscode"), Some("Cursor"));
        assert_eq!(canonical_display_name("cursor"), Some("Cursor"));
        assert_eq!(
            canonical_display_name("Visual Studio Code - Insiders"),
            Some("Visual Studio Code")
        );
        assert_eq!(canonical_display_name("zed"), Some("Zed"));
        assert_eq!(canonical_display_name("unknown-client"), None);
    }

    #[test]
    fn display_name_prefers_title_then_mapping_then_raw_name() {
        assert_eq!(
            display_name("claude-ai", Some("Claude Custom")).as_deref(),
            Some("Claude Custom")
        );
        assert_eq!(
            display_name("claude-ai", None).as_deref(),
            Some("Claude Desktop")
        );
        assert_eq!(
            display_name("  unknown-client  ", None).as_deref(),
            Some("unknown-client")
        );
        assert_eq!(display_name("  ", None).as_deref(), None);
        assert_eq!(
            display_name("claude-ai", Some("  ")).as_deref(),
            Some("Claude Desktop")
        );
    }
}
