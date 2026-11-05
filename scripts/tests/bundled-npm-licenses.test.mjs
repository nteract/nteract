import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { collectBundledNpm } from "../lib/bundled-npm-licenses.mjs";

const MIT = "Fixture license text. Permission is hereby granted, free of charge.\n";
const digest = (text) => createHash("sha256").update(text).digest("hex");

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "bundled-npm-licenses-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const lock = { lockfileVersion: "9.0", importers: {}, packages: {}, snapshots: {} };
  function file(path, content) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  function workspace(id, manifest = {}) {
    file(`${id}/package.json`, JSON.stringify({ name: id === "." ? "fixture" : id, ...manifest }));
    lock.importers[id] = {};
    for (const kind of ["dependencies", "optionalDependencies", "devDependencies"]) {
      if (!manifest[kind]) continue;
      lock.importers[id][kind] = Object.fromEntries(Object.entries(manifest[kind]).map(([name, version]) => [name, { specifier: version, version }]));
    }
  }
  function pkg(name, { version = "1.0.0", license = "MIT", dependencies = {}, files = { LICENSE: MIT }, ...other } = {}) {
    const dir = `node_modules/${name}`;
    file(`${dir}/package.json`, JSON.stringify({ name, version, license, dependencies, ...other }));
    for (const [path, contents] of Object.entries(files)) file(`${dir}/${path}`, contents);
    lock.packages[`${name}@${version}`] = { resolution: { integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}` } };
    lock.snapshots[`${name}@${version}`] = { dependencies };
  }
  function link(owner, name, target) {
    const path = join(root, owner, "node_modules", name);
    mkdirSync(dirname(path), { recursive: true });
    symlinkSync(join(root, target), path, "junction");
  }
  workspace(".");
  workspace("apps/notebook");
  workspace("packages/sift");
  return { root, lock, file, workspace, pkg, link, collect: () => { file("pnpm-lock.yaml", JSON.stringify(lock)); return collectBundledNpm(root); } };
}

test("returns deterministic CycloneDX components, purls, lock integrity and complete nested notices", async (t) => {
  const f = fixture(t);
  f.workspace(".", { dependencies: { zed: "1.0.0", "@scope/alpha": "1.0.0" } });
  f.pkg("zed", { files: { LICENSE: MIT, "vendor/NOTICE.txt": "Nested notice\nwith all lines\n", "fonts/LICENSE-OFL.txt": "Entire nested font license\n", "licenses/third-party.txt": "Entire third party text\n", "dist/bundle.js": "/*! Bundled license information:\nCopyright fixture author\nFull preserved block\n*/\nconsole.log(1);" } });
  f.pkg("@scope/alpha");
  const first = await f.collect();
  const second = await f.collect();
  assert.deepEqual(first, second);
  assert.deepEqual(first.components.map((c) => c.purl), ["pkg:npm/%40scope/alpha@1.0.0", "pkg:npm/zed@1.0.0"]);
  for (const component of first.components) {
    assert.equal(component["bom-ref"], component.purl);
    assert.equal(component.type, "library");
    assert.deepEqual(component.licenses, [{ expression: "MIT" }]);
    assert.ok(component.properties.some((p) => p.name.endsWith("source-integrity")));
    assert.ok(component.properties.some((p) => p.value.includes("overapproximation")));
  }
  assert.match(first.notices, /Nested notice\nwith all lines\n/);
  assert.match(first.notices, /Entire nested font license\n/);
  assert.match(first.notices, /Entire third party text\n/);
  assert.match(first.notices, /\/\*! Bundled license information:\nCopyright fixture author\nFull preserved block\n\*\//);
  assert.doesNotMatch(first.notices, new RegExp(f.root));
});

test("workspace recursion includes transitive dependencies, resolved peers, shipped exceptions and vendored notices", async (t) => {
  const f = fixture(t);
  f.workspace(".", { dependencies: { "@nteract/sift": "link:packages/sift" }, devDependencies: { "@bokeh/bokehjs": "1.0.0", "test-only": "1.0.0" } });
  f.workspace("apps/notebook", { devDependencies: { "tw-animate-css": "1.0.0" } });
  f.workspace("packages/sift", { dependencies: { nested: "link:../nested" }, devDependencies: { "@nteract/odometer": "link:../odometer" } });
  f.workspace("packages/nested", { dependencies: { alpha: "1.0.0" } });
  f.workspace("packages/odometer");
  f.link(".", "@nteract/sift", "packages/sift");
  f.link("packages/sift", "nested", "packages/nested");
  f.link("packages/sift", "@nteract/odometer", "packages/odometer");
  f.file("packages/sift/src/LICENSE.lucide", "Vendored icon copyright and license\n");
  f.pkg("alpha", { dependencies: { beta: "1.0.0" }, peerDependencies: { peer: "*" } });
  f.lock.snapshots["alpha@1.0.0"].dependencies.peer = "1.0.0";
  f.pkg("beta");
  f.pkg("peer");
  f.pkg("tw-animate-css");
  const report = await f.collect();
  assert.deepEqual(report.components.map((c) => c.name), ["alpha", "beta", "peer", "tw-animate-css"]);
  assert.match(report.notices, /Vendored icon copyright and license/);
});

test("missing license file fails even with SPDX metadata or NOTICE", async (t) => {
  const f = fixture(t);
  f.workspace(".", { dependencies: { alpha: "1.0.0" } });
  f.pkg("alpha", { files: { NOTICE: "Copyright author" } });
  await assert.rejects(f.collect(), /missing full LICENSE\/COPYING/);
});

test("missing, unknown and unlicensed metadata fail rather than inventing an expression", async (t) => {
  for (const license of [null, "UNLICENSED", "not-a-license", "LicenseRef-Unreviewed"]) {
    const f = fixture(t);
    f.workspace(".", { dependencies: { alpha: "1.0.0" } });
    f.pkg("alpha", { license });
    await assert.rejects(f.collect(), /missing or invalid SPDX/);
  }
});

test("missing optional installed dependency fails closed", async (t) => {
  const f = fixture(t);
  f.workspace(".", { optionalDependencies: { missing: "1.0.0" } });
  await assert.rejects(f.collect(), /Missing installed package missing/);
});

test("installed version mismatch and incomplete lock edges fail", async (t) => {
  const f = fixture(t);
  f.workspace(".", { dependencies: { alpha: "1.0.0" } });
  f.pkg("alpha");
  f.file("node_modules/alpha/package.json", JSON.stringify({ name: "alpha", version: "2.0.0", license: "MIT" }));
  await assert.rejects(f.collect(), /Installed\/locked version mismatch/);
  f.pkg("alpha", { dependencies: { beta: "1.0.0" } });
  f.lock.snapshots["alpha@1.0.0"] = {};
  await assert.rejects(f.collect(), /declared dependency beta missing from lock snapshot/);
});

test("shared transitive dependencies and cycles emit each component once", async (t) => {
  const f = fixture(t);
  f.workspace(".", { dependencies: { alpha: "1.0.0", beta: "1.0.0" } });
  f.pkg("alpha", { dependencies: { beta: "1.0.0" } });
  f.pkg("beta", { dependencies: { alpha: "1.0.0" } });
  assert.equal((await f.collect()).components.length, 2);
});

test("unreviewed Plotly embedded bundles, font payloads and native sources fail closed", async (t) => {
  const f = fixture(t);
  f.workspace(".", { dependencies: { "plotly.js-dist-min": "1.0.0", katex: "1.0.0", native: "1.0.0" } });
  f.pkg("plotly.js-dist-min", { files: { LICENSE: MIT, "plotly.min.js": "/*! Bundled license information: MIT labels are not full texts */" } });
  f.pkg("katex", { files: { LICENSE: MIT, "dist/fonts/KaTeX_Main.woff2": "fixture font bytes" } });
  f.pkg("native", { files: { LICENSE: MIT, "vendor/embedded.c": "int fixture;" } });
  await assert.rejects(f.collect(), (error) => {
    assert.match(error.message, /opaque upstream JavaScript bundle/);
    assert.match(error.message, /unreviewed font payloads/);
    assert.match(error.message, /unreviewed native\/embedded payloads/);
    return true;
  });
});

test("empty and escaping notice files fail", async (t) => {
  const f = fixture(t);
  f.workspace(".", { dependencies: { alpha: "1.0.0" } });
  f.pkg("alpha", { files: { LICENSE: " " } });
  await assert.rejects(f.collect(), /Empty license\/notice/);
  f.pkg("alpha");
  symlinkSync(join(f.root, "package.json"), join(f.root, "node_modules/alpha/NOTICE"));
  await assert.rejects(f.collect(), /Unreviewed symlink/);
});

test("reviewed supplements preserve full text, scope and components and reject changed payloads", async (t) => {
  const f = fixture(t);
  f.workspace(".", { dependencies: { katex: "1.0.0" } });
  f.pkg("katex", { files: { LICENSE: MIT, "dist/fonts/test.woff2": "font payload" } });
  const font = { type: "library", name: "fixture-font", version: "1.0.0", purl: "pkg:generic/fixture-font@1.0.0", "bom-ref": "pkg:generic/fixture-font@1.0.0", licenses: [{ expression: "OFL-1.1" }] };
  const supplement = { schemaVersion: 1, packages: { "katex@1.0.0": { files: { "dist/fonts/test.woff2": digest("font payload") }, covers: ["fonts"], notices: [{ path: "font-OFL.txt", sha256: digest("Full reviewed font text\n"), source: "https://example.org/fonts/v1/LICENSE" }], components: [font] } } };
  f.file("scripts/licenses/bundled-npm-supplements.json", JSON.stringify(supplement));
  f.file("scripts/licenses/font-OFL.txt", "Full reviewed font text\n");
  const report = await f.collect();
  assert.equal(report.components.length, 2);
  assert.match(report.notices, /Full reviewed font text\n/);
  assert.ok(report.components[0].properties.some((p) => p.name.endsWith("supplement-for")));
  f.file("node_modules/katex/dist/fonts/test.woff2", "different payload");
  await assert.rejects(f.collect(), /supplemental input digest mismatch/);
  f.file("node_modules/katex/dist/fonts/test.woff2", "font payload");
  f.file("scripts/licenses/font-OFL.txt", "changed legal text");
  await assert.rejects(f.collect(), /invalid supplemental notice text, digest or source/);
});

test("font coverage requires every font digest, not just a top-level license", async (t) => {
  const f = fixture(t);
  f.workspace(".", { dependencies: { alpha: "1.0.0" } });
  f.pkg("alpha", { files: { LICENSE: MIT, "fonts/one.ttf": "first", "fonts/two.ttf": "second" } });
  f.file("scripts/licenses/full-license.txt", MIT);
  f.file("scripts/licenses/bundled-npm-supplements.json", JSON.stringify({ schemaVersion: 1, packages: { "alpha@1.0.0": { files: { "fonts/one.ttf": digest("first") }, covers: ["fonts"], notices: [{ path: "full-license.txt", sha256: digest(MIT), source: "https://example.org/v1/LICENSE" }] } } }));
  await assert.rejects(f.collect(), /unreviewed font payloads/);
});

test("explicit full-license supplement repairs upstream package omission without license guessing", async (t) => {
  const f = fixture(t);
  f.workspace(".", { dependencies: { alpha: "1.0.0" } });
  f.pkg("alpha", { files: { "index.js": "source" }, license: null, licenses: [{ type: "MIT" }] });
  f.file("scripts/licenses/full-license.txt", MIT);
  f.file("scripts/licenses/bundled-npm-supplements.json", JSON.stringify({ schemaVersion: 1, packages: { "alpha@1.0.0": { files: { "index.js": digest("source") }, covers: ["full-license"], notices: [{ path: "full-license.txt", sha256: digest(MIT), source: "https://example.org/v1/LICENSE" }] } } }));
  assert.deepEqual((await f.collect()).components[0].licenses, [{ expression: "MIT" }]);
});

test("npm aliases preserve upstream package identity instead of inventing an alias component", async (t) => {
  const f = fixture(t);
  f.workspace(".", { dependencies: { alias: "alpha@1.0.0" } });
  f.pkg("alpha");
  f.link(".", "alias", "node_modules/alpha");
  assert.equal((await f.collect()).components[0].purl, "pkg:npm/alpha@1.0.0");
});

test("only the audited KaTeX source-only font is excluded, not future versions or new payloads", async (t) => {
  const f = fixture(t);
  f.workspace(".", { dependencies: { katex: "0.16.38" } });
  f.pkg("katex", { version: "0.16.38", files: { LICENSE: MIT, "src/fonts/lib/Extra.otf": "source build input" } });
  assert.equal((await f.collect()).components.length, 1);
  f.file("node_modules/katex/dist/fonts/new.ttf", "new payload");
  await assert.rejects(f.collect(), /unreviewed font payloads/);
  f.workspace(".", { dependencies: { katex: "0.17.0" } });
  f.pkg("katex", { version: "0.17.0", files: { LICENSE: MIT, "src/fonts/lib/Extra.otf": "source build input" } });
  await assert.rejects(f.collect(), /unreviewed font payloads/);
});
