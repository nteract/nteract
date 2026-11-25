// A view's libraries in @nteract/output-frame: the host checks the map the
// page supplies, and the frame runtime builds its import map from the mount
// payload, never from the frame document.
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM, VirtualConsole } from "jsdom";
import { BOOTSTRAP_HTML, BOOT_MESSAGE } from "@nteract/output-frame/bootstrap";
import { connectMessageType } from "@nteract/output-frame/lifecycle";
import {
  MAX_LIBRARIES,
  MAX_LIBRARY_FILES,
  checkLibraries,
  preparePayload,
} from "@nteract/output-frame/payload";
import { frameImportMap } from "@nteract/output-frame/import-map";
import { mountModuleOutput } from "@nteract/output-frame";
import { frameRuntimeText } from "../scripts/build-output.mjs";

const origin = "https://pages.example";
const revision = "a".repeat(64);
const url = (file, at = origin, pin = revision) => `${at}/catalog/${pin}/${file}`;
const entry = {
  bytes: new TextEncoder().encode("export function render() {}"),
  mediaType: "text/javascript",
};
const modulePayload = (fields) => ({ kind: "module", assets: { entry }, ...fields });

const hash = (n) => "sha256-" + Buffer.alloc(32, n).toString("base64");

test("a library map names modules on the page's origin, from one catalog revision", () => {
  const libraries = { d3: url("d3.js"), "@observablehq/plot": url("observablehq-plot.js") };
  const integrity = { [url("d3.js")]: hash(1), [url("chunk-ABC.js")]: hash(2) };
  assert.deepEqual(checkLibraries(libraries, origin), { libraries, integrity: undefined });
  assert.deepEqual(checkLibraries(libraries, origin, integrity), { libraries, integrity });
  assert.deepEqual(checkLibraries(undefined, origin), {
    libraries: undefined,
    integrity: undefined,
  });
  assert.deepEqual(checkLibraries({}, origin), { libraries: undefined, integrity: undefined });
  // http only on a loopback host.
  for (const local of ["http://localhost:9894", "http://127.0.0.1:9894", "http://[::1]:9894"])
    assert.deepEqual(checkLibraries({ d3: url("d3.js", local) }, local).libraries, {
      d3: url("d3.js", local),
    });
  // A map of the most entries passes; one more is refused.
  const many = (count) =>
    Object.fromEntries(Array.from({ length: count }, (_, i) => [`lib${i}`, url(`lib${i}.js`)]));
  assert.equal(
    Object.keys(checkLibraries(many(MAX_LIBRARIES), origin).libraries).length,
    MAX_LIBRARIES,
  );
  assert.throws(() => checkLibraries(many(MAX_LIBRARIES + 1), origin), /at most 64 libraries/);
  const files = (count) =>
    Object.fromEntries(Array.from({ length: count }, (_, i) => [url(`f${i}.js`), hash(i)]));
  assert.equal(
    Object.keys(checkLibraries(libraries, origin, files(MAX_LIBRARY_FILES)).integrity).length,
    MAX_LIBRARY_FILES,
  );
  assert.throws(
    () => checkLibraries(libraries, origin, files(MAX_LIBRARY_FILES + 1)),
    /at most 256 modules/,
  );
});

for (const [name, integrity, message] of [
  [
    "a URL on another origin",
    { [url("d3.js", "https://cdn.example")]: hash(1) },
    /library catalog/,
  ],
  ["another revision", { [url("d3.js", origin, "b".repeat(64))]: hash(1) }, /one catalog revision/],
  ["a value that is not sha256", { [url("d3.js")]: "sha384-" + "A".repeat(64) }, /sha256-<base64>/],
  ["a hex value", { [url("d3.js")]: "sha256-" + "a".repeat(64) }, /sha256-<base64>/],
  ["an array", [hash(1)], /object of library module URLs/],
])
  test(`library integrity with ${name} is refused`, () => {
    assert.throws(() => checkLibraries({ d3: url("d3.js") }, origin, integrity), message);
  });

test("library integrity needs libraries", () => {
  assert.throws(
    () => checkLibraries(undefined, origin, { [url("d3.js")]: hash(1) }),
    /object of names to URLs/,
  );
  assert.throws(() => checkLibraries({}, origin, { [url("d3.js")]: hash(1) }), /integrity/);
});

for (const [name, libraries, at, message] of [
  ["another origin", { d3: url("d3.js", "https://cdn.example") }, origin, /library catalog/],
  ["a page without an origin", { d3: url("d3.js") }, undefined, /library catalog/],
  [
    "two revisions",
    { d3: url("d3.js"), react: url("react.js", origin, "b".repeat(64)) },
    origin,
    /one catalog revision/,
  ],
  [
    "http on a public host",
    { d3: url("d3.js", "http://pages.example") },
    "http://pages.example",
    /over https/,
  ],
  ["a path outside the catalog", { d3: `${origin}/assets/d3.js` }, origin, /library catalog/],
  ["a short revision", { d3: `${origin}/catalog/abc/d3.js` }, origin, /library catalog/],
  ["a stylesheet", { d3: url("d3.css") }, origin, /library catalog/],
  ["a query", { d3: url("d3.js") + "?v=1" }, origin, /library catalog/],
  ["a fragment", { d3: url("d3.js") + "#x" }, origin, /library catalog/],
  [
    "credentials",
    { d3: url("d3.js").replace("https://", "https://user:pw@") },
    origin,
    /library catalog/,
  ],
  [
    "a URL that is not normalized",
    { d3: `${origin}/catalog/./${revision}/d3.js` },
    origin,
    /library catalog/,
  ],
  ["a relative URL", { d3: `/catalog/${revision}/d3.js` }, origin, /absolute URL/],
  ["a value that is not a string", { d3: 7 }, origin, /absolute URL/],
  ["a relative name", { "./d3": url("d3.js") }, origin, /bare specifier/],
  ["a prototype key", { constructor: url("d3.js") }, origin, /bare specifier/],
  ["an array", [url("d3.js")], origin, /object of names/],
])
  test(`a library map with ${name} is refused`, () => {
    assert.throws(() => checkLibraries(libraries, at), message);
  });

test("the payload carries the checked map; mounting checks it against the document's origin", () => {
  const libraries = { d3: url("d3.js") };
  assert.deepEqual(preparePayload(modulePayload({ libraries }), { origin }).libraries, libraries);
  assert.equal(preparePayload(modulePayload({}), { origin }).libraries, undefined);
  const { window } = new JSDOM("<!doctype html><body></body>", { url: origin + "/p/page" });
  try {
    assert.throws(
      () =>
        mountModuleOutput(
          window.document.body,
          modulePayload({ libraries: { d3: url("d3.js", "https://cdn.example") } }),
          { frameUrl: "https://outputs.example/frame/v2/", runtime: "" },
        ),
      /library catalog/,
    );
    assert.equal(window.document.querySelector("iframe"), null);
  } finally {
    window.close();
  }
});

test("the frame's import map: libraries first, then bound names, and no name replaces a library", () => {
  const libraries = { d3: url("d3.js"), react: url("react.js") };
  assert.deepEqual(
    frameImportMap(libraries, [
      ["helper", "blob:helper"],
      ["data/sales", "blob:sales"],
    ]),
    { imports: { ...libraries, helper: "blob:helper", "data/sales": "blob:sales" } },
  );
  assert.deepEqual(frameImportMap(undefined, [["helper", "blob:helper"]]), {
    imports: { helper: "blob:helper" },
  });
  const integrity = { [url("d3.js")]: hash(1) };
  assert.deepEqual(frameImportMap(libraries, [], integrity), { imports: libraries, integrity });
  assert.throws(
    () => frameImportMap(libraries, [["d3", "blob:d3"]]),
    /A bound import shadows a library: d3/,
  );
});

/** This build's runtime, booted in a frame document, and the answers it
 * sends on its port once it receives `mount`. */
async function runtimeMount(t, payload, html = BOOTSTRAP_HTML) {
  const virtualConsole = new VirtualConsole();
  const nonce = "mount-nonce";
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    url: `https://outputs.example/frame/v2/#${nonce}`,
    virtualConsole,
  });
  t.after(() => dom.window.close());
  // jsdom has no blob URLs; the runtime only names them in its map.
  let blobs = 0;
  dom.window.URL.createObjectURL = () => `blob:frame/${++blobs}`;
  dom.window.URL.revokeObjectURL = () => {};
  const { port1, port2 } = new MessageChannel();
  t.after(() => {
    port1.close();
    port2.close();
  });
  const messages = [];
  port1.onmessage = ({ data }) => messages.push(data);
  dom.window.dispatchEvent(
    new dom.window.MessageEvent("message", {
      data: {
        type: BOOT_MESSAGE,
        runtime: await frameRuntimeText(),
        connect: connectMessageType(),
        nonce,
      },
      source: dom.window,
      ports: [port2],
    }),
  );
  const settle = async (check) => {
    for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setImmediate(r));
  };
  await settle(() => messages.some((m) => m.type === "connected"));
  port1.postMessage({ type: "mount", payload, context: { theme: "light" }, files: {} });
  await settle(() => messages.some((m) => m.type === "error" || m.type === "phase"));
  const maps = [...dom.window.document.querySelectorAll('script[type="importmap"]')].map((script) =>
    JSON.parse(script.textContent),
  );
  return { messages, maps, document: dom.window.document };
}

test("the runtime's import map comes from the payload's libraries", async (t) => {
  const libraries = { d3: url("d3.js"), "@observablehq/plot": url("observablehq-plot.js") };
  const helper = {
    bytes: new TextEncoder().encode("export default 1;"),
    mediaType: "text/javascript",
  };
  const libraryIntegrity = { [url("d3.js")]: hash(1), [url("chunk-ABC.js")]: hash(2) };
  const { maps, document } = await runtimeMount(
    t,
    preparePayload(modulePayload({ libraries, libraryIntegrity, imports: { helper } }), {
      origin,
    }),
  );
  assert.equal(maps.length, 1);
  assert.deepEqual(maps[0].integrity, libraryIntegrity);
  assert.deepEqual(Object.keys(maps[0].imports), ["d3", "@observablehq/plot", "helper"]);
  assert.equal(maps[0].imports.d3, libraries.d3);
  assert.equal(maps[0].imports["@observablehq/plot"], libraries["@observablehq/plot"]);
  assert.match(maps[0].imports.helper, /^blob:/);
  // The frame document names no library: the map is the runtime's.
  assert.equal(document.getElementById("widget-catalog-map"), null);
});

test("a bound import that shadows a library fails the mount before any import map", async (t) => {
  const d3 = { bytes: new TextEncoder().encode("export default 1;"), mediaType: "text/javascript" };
  const { messages, maps } = await runtimeMount(
    t,
    preparePayload(modulePayload({ libraries: { d3: url("d3.js") }, imports: { d3 } }), {
      origin,
    }),
  );
  assert.deepEqual(maps, []);
  assert.deepEqual(
    messages.filter((m) => m.type === "error"),
    [{ type: "error", message: "A bound import shadows a library: d3" }],
  );
});

test("a frame document's own map tag is not a library source", async (t) => {
  // Only the payload names libraries: a tag in the document is ignored.
  const tagged = BOOTSTRAP_HTML.replace(
    "</head>",
    `<script type="application/json" id="widget-catalog-map">${JSON.stringify({ imports: { d3: url("d3.js") } })}</script></head>`,
  );
  const { maps } = await runtimeMount(t, preparePayload(modulePayload({}), { origin }), tagged);
  assert.deepEqual(maps, []);
});
