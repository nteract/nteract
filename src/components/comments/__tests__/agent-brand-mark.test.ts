import { describe, expect, it } from "vite-plus/test";
import { AGENT_BRAND_PATHS } from "../agent-brand-glyphs";
import { agentBrandMarkSvg } from "../agent-brand-mark";

describe("agentBrandMarkSvg", () => {
  it.each([
    ["codex", "openai"],
    [" Claude-Code ", "claude"],
    ["gemini-cli", "google-gemini"],
  ] as const)("maps the known %s brand", (slug, brand) => {
    expect(agentBrandMarkSvg(slug, 16)).toContain(`d="${AGENT_BRAND_PATHS[brand]}"`);
  });

  it.each(["unknown-agent", "__proto__", "constructor", "toString"])(
    "uses the neutral glyph for non-registry key %s",
    (slug) => {
      const svg = agentBrandMarkSvg(slug, 16);

      expect(svg).toContain('stroke="currentColor"');
      expect(svg).not.toContain('d="undefined"');
    },
  );
});
