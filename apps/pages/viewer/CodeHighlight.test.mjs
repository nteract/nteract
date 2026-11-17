import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const bundled = await build({
  entryPoints: [fileURLToPath(new URL("./CodeHighlight.jsx", import.meta.url))],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  jsx: "automatic",
  loader: { ".css": "empty" },
  plugins: [
    {
      name: "shared-react",
      setup(build) {
        build.onResolve({ filter: /^[^./]/ }, (args) => ({
          path: pathToFileURL(require.resolve(args.path)).href,
          external: true,
        }));
      },
    },
  ],
});
const { CodeHighlight } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
);

const render = (text, language) =>
  new JSDOM(renderToStaticMarkup(createElement(CodeHighlight, { text, language }))).window.document;

test("code previews highlight JavaScript and CSS without changing or interpreting the text", () => {
  for (const [language, text, selector, token] of [
    [
      "javascript",
      'export default "<img src=x onerror=alert(1)>";\n// comment\n',
      ".wg-t-keyword",
      "export",
    ],
    ["css", ".widget { color: teal; }\n/* comment */", ".wg-t-prop", "color"],
  ]) {
    const doc = render(text, language);
    assert.equal(doc.querySelector("code").textContent, text);
    assert.equal(doc.querySelector(selector).textContent, token);
    assert.ok(doc.querySelector(".wg-t-comment"));
    assert.equal(doc.querySelector("img"), null);
  }
});

test("unknown languages and text beyond the highlight budget remain readable and copyable", () => {
  const text = 'const value = "😀";\n' + " ".repeat(10000) + "const tail = 42;\n";
  const doc = render(text, "javascript");
  assert.equal(doc.querySelector("code").textContent, text);
  assert.equal(
    doc.querySelector("code").lastChild.textContent.endsWith("const tail = 42;\n"),
    true,
  );
  const unknown = render(text, "unknown");
  assert.equal(unknown.querySelector("code").textContent, text);
  assert.equal(unknown.querySelectorAll("span").length, 0);
});
