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
const { AgentMark, agentMarkFor } = await import(
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
