import { Bot } from "lucide-react";
import {
  AGENT_BRAND_PATHS,
  AGENT_BRAND_VIEW_BOX,
  type AgentBrandId,
} from "@/components/comments/agent-brand-glyphs";

/**
 * The mark for an agent that authored a comment, keyed by the brand slug in its
 * actor label (`agent:claude-code:s1` -> `claude-code`).
 *
 * Marks are single-color glyphs drawn in `currentColor`, so an agent's avatar
 * keeps carrying its identity color — the same color as that agent's cursor,
 * edits, and highlights — instead of introducing a second, unrelated brand
 * color next to it. A vendor's full-color tile would break that link and put
 * chroma somewhere design law reserves for meaning tokens.
 */

/** Lucide `Bot`, as markup, for surfaces that build their avatar by hand. */
const BOT_GLYPH_PATHS =
  '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>';

/**
 * Slugs come from whatever a client presented as its operator, so the several
 * spellings of one product all reach its mark. Names follow the client roster in
 * `crates/mcp-client-branding`; a slug that is missing here draws the neutral bot
 * rather than a neighboring vendor's logo.
 */
const BRAND_BY_SLUG: Readonly<Record<string, AgentBrandId>> = {
  anthropic: "anthropic",
  "anthropic-api": "anthropic",
  claude: "claude",
  "claude-ai": "claude",
  "claude-cli": "claude",
  "claude-code": "claude",
  "claude-desktop": "claude",
  chatgpt: "openai",
  codex: "openai",
  "codex-cli": "openai",
  "codex-mcp-client": "openai",
  openai: "openai",
  "openai-codex": "openai",
  antigravity: "google-gemini",
  gemini: "google-gemini",
  "gemini-cli": "google-gemini",
  "google-antigravity": "google-gemini",
  "google-gemini": "google-gemini",
  copilot: "github-copilot",
  "copilot-studio": "github-copilot",
  "github-copilot": "github-copilot",
  "github-copilot-developer": "github-copilot",
  cursor: "cursor",
  "cursor-vscode": "cursor",
  windsurf: "windsurf",
  "windsurf-client": "windsurf",
  "windsurf-editor": "windsurf",
  codeium: "codeium",
  cline: "cline",
  zed: "zed",
  "zed-industries": "zed",
  "le-chat": "mistral-ai",
  mistral: "mistral-ai",
  "mistral-ai": "mistral-ai",
  perplexity: "perplexity",
  opencode: "opencode",
  trae: "trae",
};

function agentBrandId(slug: string | null | undefined): AgentBrandId | null {
  const normalized = slug?.trim().toLowerCase();
  return normalized ? (BRAND_BY_SLUG[normalized] ?? null) : null;
}

/** The agent's mark for React surfaces, falling back to a neutral bot glyph. */
export function AgentBrandMark({ slug, className }: { slug?: string | null; className?: string }) {
  const brand = agentBrandId(slug);
  if (!brand) return <Bot className={className} aria-hidden="true" />;
  return (
    <svg
      viewBox={AGENT_BRAND_VIEW_BOX}
      className={className}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d={AGENT_BRAND_PATHS[brand]} />
    </svg>
  );
}

/**
 * The same mark as markup, for the CodeMirror hover preview, which builds its
 * avatar imperatively. Both planes read one registry so an agent looks the same
 * in the panel and in the editor.
 */
export function agentBrandMarkSvg(slug: string | null | undefined, size: number): string {
  const brand = agentBrandId(slug);
  if (!brand) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${BOT_GLYPH_PATHS}</svg>`;
  }
  return `<svg width="${size}" height="${size}" viewBox="${AGENT_BRAND_VIEW_BOX}" fill="currentColor"><path d="${AGENT_BRAND_PATHS[brand]}"/></svg>`;
}
