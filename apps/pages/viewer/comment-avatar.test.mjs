import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const bundled = await build({
  entryPoints: [fileURLToPath(new URL("./CommentThreadParts.jsx", import.meta.url))],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  jsx: "automatic",
  loader: { ".css": "empty" },
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
const { Avatar, MessageAuthor } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString("base64")}`
);
const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");

const kyle = { principal: "user:t:kyle", displayName: "Kyle Kelley" };
const render = (author) => renderToStaticMarkup(createElement(Avatar, { author }));
const badge = (html) =>
  html.match(/<span class="comment-avatar-badge[^"]*">(.*?)<\/span>/)?.[0] ?? "";

test("an agent's avatar shows its harness, with the reported model's mark as the badge", () => {
  const html = render({
    ...kyle,
    driver: "Kilo",
    agent: { name: "Kilo", model: "claude-opus-5.5" },
  });
  assert.match(html, /agent-mark-kilo/);
  assert.match(badge(html), /comment-avatar-badge-mark/);
  assert.match(badge(html), /agent-mark-claude/);
  assert.match(
    html,
    /title="Kilo on behalf of Kyle Kelley\nModel reported by the client: claude-opus-5.5"/,
  );
});

test("the badge falls back to the person's initial", () => {
  // No model, a model with no mark, and a model whose mark is already the avatar.
  for (const agent of [undefined, { model: "llama-4" }]) {
    const html = render({ ...kyle, driver: "Kilo", agent });
    assert.equal(badge(html), '<span class="comment-avatar-badge">K</span>');
  }
  const claudeCode = render({
    ...kyle,
    driver: "Claude Code",
    agent: { model: "claude-opus-5.5" },
  });
  assert.match(claudeCode, /agent-mark-claude/);
  assert.equal(badge(claudeCode), '<span class="comment-avatar-badge">K</span>');
});

test("an agent with no harness mark still gets the model badge; a person gets none", () => {
  const html = render({ ...kyle, driver: "Some harness", agent: { model: "gpt-5" } });
  assert.match(badge(html), /agent-mark-openai/);
  assert.equal(badge(render({ ...kyle, driver: "Browser", agent: { model: "gpt-5" } })), "");
});

test("the byline names an agent called after its harness once, and keeps 'for Kyle'", () => {
  const html = renderToStaticMarkup(
    createElement(MessageAuthor, {
      message: {
        author: { ...kyle, driver: "Kilo", agent: { name: "Kilo", model: "claude-opus-5.5" } },
      },
      now: Date.now(),
    }),
  );
  assert.doesNotMatch(html, /via Kilo/);
  assert.match(html, /<strong>Kilo<\/strong>/);
  assert.match(html, />for Kyle</);
});
