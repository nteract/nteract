import assert from "node:assert/strict";
import { test } from "node:test";
import { checkModuleImports } from "../shared/module-imports.mjs";
import { standardImports } from "../shared/widget-imports.mjs";

const libraries = [...standardImports];
const check = (entry, options = {}) =>
  checkModuleImports({ modules: { entry }, libraries, ...options });
const unresolved = (entry, options) => check(entry, options).unresolved;

test("each kind of specifier resolves only by its exact rule", () => {
  const cases = [
    // [source, unresolved specifiers and kinds]
    [`import React from "react";`, []],
    [`import { createRoot } from "react-dom/client";`, []],
    [`import * as Plot from "@observablehq/plot";`, []],
    [`import "d3";`, []],
    [`import x from "d3/foo";`, [["d3/foo", "static"]]],
    [`import { renderToString } from "react-dom/server";`, [["react-dom/server", "static"]]],
    [`import helper from "helper";`, []],
    [`import helper from "helper/sub";`, [["helper/sub", "static"]]],
    [`import sales from "data/sales";`, []],
    [`import other from "data/other";`, [["data/other", "static"]]],
    [`import sales from "data/sales/x";`, [["data/sales/x", "static"]]],
    [`import x from "https://esm.sh/lodash";`, []],
    [`import x from "http://esm.sh/lodash";`, [["http://esm.sh/lodash", "static"]]],
    [`import fs from "node:fs";`, [["node:fs", "static"]]],
    [
      `import x from "data:text/javascript,export default 1";`,
      [["data:text/javascript,export default 1", "static"]],
    ],
    [`import x from "./local.js";`, [["./local.js", "static"]]],
    [`import x from "../up.js";`, [["../up.js", "static"]]],
    [`import x from "/root.js";`, [["/root.js", "static"]]],
    [`import x from "lodash";`, [["lodash", "static"]]],
    [`export { a } from "./a.js";`, [["./a.js", "static"]]],
    [`export * from "lodash";`, [["lodash", "static"]]],
    [`export * from "react";`, []],
    [`const lib = await import("lodash");`, [["lodash", "dynamic"]]],
    [`const lib = await import("react");`, []],
    [`const lib = await import("https://esm.sh/lodash");`, []],
    [`const lib = await import(name);`, []],
    [`const lib = await import("lo" + "dash");`, []],
    [`const url = import.meta.url;`, []],
  ];
  for (const [source, expected] of cases)
    assert.deepEqual(
      unresolved(source, { imports: ["helper"], files: ["sales"] }),
      expected.map(([specifier, kind]) => ({ specifier, in: "entry", kind })),
      source,
    );
});

test("https specifiers are external, static or dynamic", () => {
  const found = check(
    `import a from "https://esm.sh/a"; const b = await import("https://esm.sh/b"); import c from "http://esm.sh/c";`,
  );
  assert.deepEqual(found.external, [
    { specifier: "https://esm.sh/a", in: "entry" },
    { specifier: "https://esm.sh/b", in: "entry" },
  ]);
  assert.deepEqual(found.unresolved, [
    { specifier: "http://esm.sh/c", in: "entry", kind: "static" },
  ]);
});

test("a Page import module is checked by the same rule, entry first", () => {
  const found = checkModuleImports({
    modules: {
      zeta: `import "d3"; import "data/sales"; import "alpha"; import "./sibling.js";`,
      alpha: `import "lodash";`,
      entry: `import "zeta";`,
    },
    libraries,
    imports: ["alpha", "zeta"],
    files: ["sales"],
  });
  assert.deepEqual(found.unresolved, [
    { specifier: "lodash", in: "alpha", kind: "static" },
    { specifier: "./sibling.js", in: "zeta", kind: "static" },
  ]);
});

test("without libraries a library name doesn't resolve", () => {
  assert.deepEqual(
    unresolved(`import React from "react"; import "helper";`, {
      libraries: [],
      imports: ["helper"],
    }),
    [{ specifier: "react", in: "entry", kind: "static" }],
  );
});

test("a module the lexer can't parse is reported, and the others are still checked", () => {
  const found = checkModuleImports({
    modules: { entry: `import { from`, helper: `import "lodash";` },
    libraries,
    imports: ["helper"],
  });
  assert.equal(found.unparsed.length, 1);
  assert.equal(found.unparsed[0].in, "entry");
  assert.match(found.unparsed[0].message, /Parse error/);
  assert.deepEqual(found.unresolved, [{ specifier: "lodash", in: "helper", kind: "static" }]);
});

test("repeats are listed once, and a static and a dynamic use stay distinct", () => {
  const found = check(
    `import a from "lodash"; import { b } from "lodash"; const c = await import("lodash"); const d = await import("lodash"); import "https://esm.sh/x"; import "https://esm.sh/x";`,
  );
  assert.deepEqual(found.unresolved, [
    { specifier: "lodash", in: "entry", kind: "static" },
    { specifier: "lodash", in: "entry", kind: "dynamic" },
  ]);
  assert.deepEqual(found.external, [{ specifier: "https://esm.sh/x", in: "entry" }]);
});

test("a module with no imports reports nothing", () => {
  assert.deepEqual(check(`export function render({ el }) { el.textContent = "hi"; }`), {
    unresolved: [],
    external: [],
    unparsed: [],
  });
});
