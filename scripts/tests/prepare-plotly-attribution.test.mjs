import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {test} from "node:test";
import {acceptMissingMaterials, assembleMIT, exceptionSummary, legalComments, MissingMaterialError, packageMaterials, publicBytes, selectNpmLock, selectYarnLock, sha256, verifyIntegrity} from "../prepare-plotly-attribution.mjs";

test("integrity rejects missing, unsupported, and changed tarballs", () => {
  const bytes = Buffer.from("archive");
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  verifyIntegrity(bytes, integrity, "fixture");
  for (const bad of [undefined, "md5-abc", `${integrity} sha1-abc`]) assert.throws(() => verifyIntegrity(bytes, bad, "fixture"), /integrity/i);
  assert.throws(() => verifyIntegrity(Buffer.from("changed"), integrity, "fixture"), /mismatch/i);
});

test("npm selection retains production superset and explicit injected helper closure", () => {
  const lock = {lockfileVersion: 3, packages: {
    "": {dependencies: {runtime: "1"}},
    "node_modules/runtime": {version: "1", dependencies: {shared: "*"}},
    "node_modules/runtime/node_modules/shared": {version: "2"},
    "node_modules/shared": {version: "1", dev: true},
    "node_modules/browser-shim": {version: "1", dev: true, dependencies: {shared: "*"}},
    "node_modules/test-only": {version: "1", dev: true},
  }};
  const selected = selectNpmLock(lock, ["browser-shim"]);
  assert.equal(selected.length, 4);
  assert.ok(selected.some((entry) => entry.name === "shared" && entry.version === "2"));
  assert.ok(selected.some((entry) => entry.name === "shared" && entry.version === "1"));
  assert.ok(!selected.some((entry) => entry.name === "test-only"));
  assert.throws(() => selectNpmLock(lock, ["missing"]), /Missing locked dependency/);
  assert.throws(() => selectNpmLock({...lock, lockfileVersion: 1}), /lockfile v3/);
});

test("Yarn selection uses exact selectors with nested dependencies and cycles", () => {
  const entries = new Map([
    ["runtime@^1", {version: "1.2.0", dependencies: {nested: "~2"}}],
    ["nested@~2", {version: "2.1.0", dependencies: {runtime: "^1"}}],
    ["helper@^3", {version: "3.1.0"}],
  ]);
  assert.equal(selectYarnLock(entries, {dependencies: {runtime: "^1"}, devDependencies: {helper: "^3"}}, ["helper"]).length, 3);
  assert.throws(() => selectYarnLock(entries, {dependencies: {runtime: "^2"}}), /Missing yarn lock/);
});

const grant = `Copyright Example
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:
The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.`;

test("collects nested licenses, NOTICE and embedded bundled legal comments", () => {
  const files = new Map([
    ["package/package.json", JSON.stringify({name: "fixture", version: "1", license: "MIT"})],
    ["package/LICENSE", grant],
    ["package/vendor/LICENSE.txt", `${grant} Vendor`],
    ["package/dist/NOTICE", "Third-party attribution"],
    ["package/dist/bundle.js", "/* ordinary */\n/*! Copyright vendor; @license MIT */\n/* Bundled license information: MIT */"],
  ]);
  const result = packageMaterials(files, "fixture");
  assert.equal(result.materials.length, 5);
  assert.equal(result.license, "MIT");
  assert.equal(legalComments("/* ordinary */").length, 0);
});

test("fails closed on license labels, URLs, empty notices, or absent declarations", () => {
  const files = new Map([
    ["package/package.json", JSON.stringify({name: "fixture", version: "1", license: "MIT"})],
    ["package/LICENSE", "MIT: https://example.com/license"],
  ]);
  assert.throws(() => packageMaterials(files, "fixture"), /No full license/);
  files.set("package/LICENSE", grant);
  files.set("package/NOTICE", "");
  assert.throws(() => packageMaterials(files, "fixture"), /Empty legal/);
  files.delete("package/NOTICE");
  files.set("package/package.json", JSON.stringify({name: "fixture", version: "1"}));
  assert.throws(() => packageMaterials(files, "fixture"), /Unresolved license/);
});

test("supports DefinitelyTyped archive roots and full README grants", () => {
  const files = new Map([
    ["estree/package.json", JSON.stringify({name: "@types/estree", version: "1", license: "MIT"})],
    ["estree/README.md", grant],
  ]);
  assert.equal(packageMaterials(files, "fixture").materials[0].path, "estree/README.md");
  files.set("another/package.json", "{}");
  assert.throws(() => packageMaterials(files, "fixture"), /ambiguous package metadata/);
});

test("requires all mandatory dependency locations even in transitive build closure", () => {
  const lock = {lockfileVersion: 3, packages: {"": {}, "node_modules/shim": {version: "1", dev: true, dependencies: {missing: "^1"}}}};
  assert.throws(() => selectNpmLock(lock, ["shim"]), /Missing locked dependency missing/);
});

test("retains contiguous line-comment legal headers", () => {
  const source = "// Copyright (C) 2011 Google Inc.\n// Licensed under the Apache License, Version 2.0\n// You may obtain a copy at the official URL.\nconst code = 1;\n";
  assert.equal(legalComments(source).length, 1);
  assert.match(legalComments(source)[0], /You may obtain a copy/);
  assert.doesNotMatch(legalComments(source)[0], /const code/);
});

test("license grant matching handles wrapped words but rejects an incomplete header", () => {
  const files = new Map([
    ["package/package.json", JSON.stringify({name: "fixture", version: "1", license: "MIT"})],
    ["package/LICENSE", grant.replace("hereby granted", "hereby\n granted")],
  ]);
  assert.equal(packageMaterials(files, "fixture").license, "MIT");
  files.set("package/LICENSE", "Permission is hereby granted, free of charge. See https://example.com for warranty details.");
  assert.throws(() => packageMaterials(files, "fixture"), /No full license/);
});

test("a nested vendor grant cannot substitute for the package owner license", () => {
  const files = new Map([
    ["package/package.json", JSON.stringify({name: "fixture", version: "1", license: "BSD-3-Clause"})],
    ["package/vendor/LICENSE", grant],
  ]);
  assert.throws(() => packageMaterials(files, "fixture"), /No full license/);
});

test("emitted helper owners do not pull in build-time AST dependency trees", () => {
  const lock = {lockfileVersion: 3, packages: {
    "": {dependencies: {runtime: "1"}},
    "node_modules/runtime": {version: "1"},
    "node_modules/helper": {version: "1", dev: true, dependencies: {ast: "1"}},
    "node_modules/ast": {version: "1", dev: true},
  }};
  assert.deepEqual(selectNpmLock(lock, [], ["helper"]).map((item) => item.name), ["helper", "runtime"]);
});

test("assembled MIT is version-reviewed and preserves exact source holder", () => {
  const text = "MIT\nCopyright 2013, JP Richardson  <jprichardson@gmail.com>";
  const files = new Map([["package/README.md", text]]);
  const review = {path: "package/README.md", sha256: sha256(text), declaration: "MIT", copyright: "Copyright 2013, JP Richardson  <jprichardson@gmail.com>"};
  const canonical = grant.replace("Copyright Example", "Copyright (c) <year> <copyright holders>");
  assert.match(assembleMIT(files, review, canonical), /not an original upstream LICENSE/);
  assert.ok(assembleMIT(files, review, canonical).includes(review.copyright));
  assert.throws(() => assembleMIT(files, {...review, copyright: "Someone Else"}, canonical), /changed/);
  assert.throws(() => assembleMIT(files, {...review, sha256: "0".repeat(64)}, canonical), /changed/);
});

test("public cache reuses exact bytes offline and rejects tampering", async (t) => {
  const cache = await mkdtemp(join(tmpdir(), "plotly-cache-"));
  t.after(() => rm(cache, {recursive: true, force: true}));
  const url = "https://registry.npmjs.org/fixture/1.0.0";
  const bytes = Buffer.from("fixture");
  let calls = 0;
  const fetcher = async () => { calls++; return new Response(bytes); };
  assert.deepEqual(await publicBytes(url, sha256(bytes), {cache, fetcher}), bytes);
  assert.deepEqual(await publicBytes(url, sha256(bytes), {cache, fetcher: () => { throw new Error("offline"); }}), bytes);
  assert.equal(calls, 1);
  const path = join(cache, `${sha256(url)}.json`);
  const stored = JSON.parse(await readFile(path, "utf8"));
  await writeFile(path, JSON.stringify({...stored, base64: Buffer.from("changed").toString("base64")}));
  await assert.rejects(publicBytes(url, sha256(bytes), {cache, fetcher}), /Cached source SHA256 mismatch/);
});

test("public fetch retries transient failures but distinguishes forbidden from absent", async (t) => {
  const cache = await mkdtemp(join(tmpdir(), "plotly-network-"));
  t.after(() => rm(cache, {recursive: true, force: true}));
  const url = "https://raw.githubusercontent.com/fixture/source";
  let calls = 0;
  const fetcher = async () => { calls++; return new Response(calls < 3 ? "unavailable" : "ok", {status: calls < 3 ? 503 : 200}); };
  assert.equal((await publicBytes(url, undefined, {cache, fetcher})).toString(), "ok");
  assert.equal(calls, 3);
  await assert.rejects(publicBytes(`${url}/forbidden`, undefined, {cache, fetcher: async () => new Response("limited", {status: 403})}), /not evidence of absence.*403/);
  await assert.rejects(publicBytes(`${url}/absent`, undefined, {cache, fetcher: async () => new Response("absent", {status: 404})}), /: 404$/);
  await assert.rejects(publicBytes("https://private.example/secret", undefined, {cache, fetcher}), /Non-public source/);
});

function exceptionFixture() {
  const text = JSON.stringify({name: "array-normalize", version: "1.1.4", license: "MIT"});
  const files = new Map([["package/package.json", text], ["package/readme.md", "MIT; no copyright notice supplied"], ["package/index.js", "// MIT Licensed\nconst code = 1;"]]);
  const fingerprint = {name: "array-normalize", version: "1.1.4", tarballSha256: "a".repeat(64), registryGitHead: "b".repeat(40), bundleSha256: "c".repeat(64)};
  const exception = {...fingerprint, license: "MIT", missingMaterial: "Authoritative copyright and full terms", reason: "Exact published source has an explicit MIT declaration only", evidence: [{path: "package/package.json", sha256: sha256(text), declaration: '"license":"MIT"'}], owner: "nteract maintainers", reviewDate: "2026-12-05", trackingUrl: "https://github.com/nteract/nteract/issues/4858"};
  let error;
  try { packageMaterials(files, "array-normalize@1.1.4"); } catch (caught) { error = caught; }
  assert.ok(error instanceof MissingMaterialError);
  return {files, fingerprint, exception, error};
}

test("exact missing-material exceptions preserve declarations and all available notices without inventing holders", () => {
  const {files, fingerprint, exception, error} = exceptionFixture();
  const result = acceptMissingMaterials(error, exception, fingerprint, files);
  assert.equal(result.license, "MIT");
  assert.equal(result.exception, exception);
  for (const text of files.values()) {
    if (text.includes("const code")) continue;
    assert.ok(result.materials.some((item) => item.text === text));
  }
  assert.ok(result.materials.some((item) => item.text === "// MIT Licensed\n"));
  assert.ok(result.materials.every((item) => !item.text.includes("Permission is hereby granted")));
  assert.match(exceptionSummary([exception]), /reviewed-with-exceptions/);
  assert.match(exceptionSummary([exception]), /not a claim of complete attribution or legal approval/);
  assert.match(exceptionSummary([exception]), /issues\/4858/);
});

test("exceptions reject each changed fingerprint and do not cover new gaps", () => {
  const {files, fingerprint, exception, error} = exceptionFixture();
  for (const field of Object.keys(fingerprint)) {
    assert.throws(() => acceptMissingMaterials(error, exception, {...fingerprint, [field]: "changed"}, files), /fingerprint mismatch/);
  }
  assert.throws(() => acceptMissingMaterials(error, undefined, fingerprint, files), (caught) => caught === error);
  assert.throws(() => acceptMissingMaterials(error, exception, fingerprint, new Map([...files, ["package/package.json", "changed"]])), /source evidence changed/);
});

test("exceptions cannot suppress integrity, network, empty material, metadata or unknown-license errors", () => {
  const {files, fingerprint, exception, error} = exceptionFixture();
  for (const message of ["Integrity mismatch", "Source SHA256 mismatch", "Public source network failure", "Unresolved license declaration", "Empty legal material", "Missing or ambiguous package metadata"]) {
    const failure = new Error(message);
    assert.throws(() => acceptMissingMaterials(failure, exception, fingerprint, files), (caught) => caught === failure);
  }
  for (const license of [undefined, "UNLICENSED", "LicenseRef-unknown", "BSD-3-Clause"]) {
    assert.throws(() => acceptMissingMaterials(new MissingMaterialError("fixture", {...error.result, license}), exception, fingerprint, files), /Invalid attribution exception/);
  }
  files.set("package/NOTICE", "");
  assert.throws(() => packageMaterials(files, "fixture"), /Empty legal material/);
});

test("historical inherited MIT text does not resolve a current-source material gap", () => {
  const {files} = exceptionFixture();
  files.set("historical/README.md", grant);
  assert.throws(() => packageMaterials(files, "fixture"), (error) => error instanceof MissingMaterialError && error.result.materials.some(({text}) => text === grant));
});

test("checked-in supplement distributes bound exception notices and MIT SBOM records", async () => {
  const licenses = new URL("../licenses/", import.meta.url);
  const exceptionBytes = await readFile(new URL("plotly-exceptions.json", licenses));
  const {exceptions} = JSON.parse(exceptionBytes);
  const document = JSON.parse(await readFile(new URL("plotly-supplement.json", licenses)));
  const supplement = document.packages["plotly.js-dist-min@3.4.0"];
  assert.equal(supplement.status, "reviewed-with-exceptions");
  assert.equal(exceptions.length, 4);
  assert.equal(supplement.components.length, 278);
  assert.ok(supplement.notices.some(({path}) => path === "plotly-exceptions.txt"));
  for (const notice of supplement.notices) {
    const bytes = await readFile(new URL(notice.path, licenses));
    assert.equal(sha256(bytes), notice.sha256);
    assert.match(bytes.toString(), /reviewed-with-exceptions/);
    assert.match(bytes.toString(), /issues\/4858/);
  }
  const bundle = supplement.components.find(({name}) => name === "plotly.js-dist-min");
  assert.ok(bundle.properties.some(({name, value}) => name === "nteract:attribution:exceptions-sha256" && value === sha256(exceptionBytes)));
  for (const exception of exceptions) {
    assert.equal(exception.bundleSha256, supplement.files["plotly.min.js"]);
    const component = supplement.components.find(({name, version}) => name === exception.name && version === exception.version);
    assert.deepEqual(component.licenses, [{expression: "MIT"}]);
    assert.deepEqual(JSON.parse(component.properties.find(({name}) => name === "nteract:attribution:exception").value), exception);
    assert.ok(component.properties.some(({name, value}) => name === "nteract:attribution:status" && value === "reviewed-with-exceptions"));
  }
  const provenance = JSON.parse(await readFile(new URL("plotly-provenance.json", licenses)));
  assert.equal(provenance.status, supplement.status);
  assert.equal(provenance.exceptionsSha256, sha256(exceptionBytes));
  for (const record of provenance.packages.filter(({exception}) => exception)) {
    for (const material of record.exception.evidence) assert.ok(record.materials.some(({path, sha256}) => path === material.path && sha256 === material.sha256));
  }
});
