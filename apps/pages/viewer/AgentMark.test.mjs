import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const bundled = await build({
  entryPoints: [fileURLToPath(new URL("./AgentMark.jsx", import.meta.url))],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  jsx: "automatic",
  plugins: [
    {
      name: "external",
      setup(build) {
        build.onResolve({ filter: /^[^./]/ }, ({ path }) => ({
          path: pathToFileURL(require.resolve(path)).href,
          external: true,
        }));
      },
    },
  ],
});
const { AgentMark, agentMarkFor, modelMarkFor } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString("base64")}`
);
const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");

test("agentMarkFor recognizes the agents that comment", () => {
  assert.equal(agentMarkFor("Kilo"), "kilo");
  assert.equal(agentMarkFor("Kilo Code"), "kilo");
  assert.equal(agentMarkFor("Claude Code"), "claude");
  assert.equal(agentMarkFor("Codex"), "codex");
  assert.equal(agentMarkFor("ChatGPT"), "openai");
  assert.equal(agentMarkFor("OpenAI agent"), "openai");
  assert.equal(agentMarkFor("GitHub Copilot"), "copilot");
  assert.equal(agentMarkFor("Gemini CLI"), "gemini");
  assert.equal(agentMarkFor("Browser"), null);
  assert.equal(agentMarkFor("Some new agent"), null);
  assert.equal(agentMarkFor(undefined), null);
});

test("modelMarkFor names the maker of a reported model", () => {
  for (const model of ["claude-opus-5.5", "Claude Sonnet 4", "anthropic/claude-3", "opus-4"])
    assert.equal(modelMarkFor(model), "claude", model);
  for (const model of ["gpt-5", "openai/gpt-4.1", "o3-mini", "gpt-5-codex"])
    assert.equal(modelMarkFor(model), "openai", model);
  assert.equal(modelMarkFor("gemini-2.5-pro"), "gemini");
  for (const model of ["kilo", "llama-4", "mistral-large", "", undefined, "photo3"])
    assert.equal(modelMarkFor(model), null, String(model));
});

test("marks render as decorative SVG with gradients scoped per instance", () => {
  const html = renderToStaticMarkup(
    createElement(
      "div",
      null,
      createElement(AgentMark, { mark: "codex" }),
      createElement(AgentMark, { mark: "codex" }),
    ),
  );
  assert.match(html, /<svg[^>]*aria-hidden="true"/);
  const ids = [...html.matchAll(/linearGradient[^>]*id="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1], "two marks on one screen don't share gradient ids");
  for (const id of ids) assert.ok(html.includes(`url(#${id})`));
  assert.equal(renderToStaticMarkup(createElement(AgentMark, { mark: "unknown" })), "");
});
