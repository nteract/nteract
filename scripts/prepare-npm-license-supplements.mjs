import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destination = join(root, "scripts/licenses");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const raw = "https://raw.githubusercontent.com/";

// Exact reviewed releases only. New versions require reviewing their upstream
// provenance, not substituting a generic license based on the SPDX identifier.
const radix = [
  "number@1.1.1", "react-compose-refs@1.1.2", "react-context@1.1.2",
  "react-direction@1.1.1", "react-id@1.1.1", "react-use-callback-ref@1.1.1",
  "react-use-escape-keydown@1.1.1", "react-use-layout-effect@1.1.1",
  "react-use-previous@1.1.1", "react-use-rect@1.1.1", "react-use-size@1.1.1", "rect@1.1.1",
];
const sources = [
  {
    packages: radix.map((name) => `@radix-ui/${name}`),
    repository: "radix-ui/primitives", license: "MIT", file: "radix-ui.txt",
    // npm gitHead for these releases; root license covers the primitives monorepo.
    upstream: "radix-ui/primitives/fcef0668a5c827e5a4baac405474d75680f9a4eb/LICENSE",
    hash: "0e80a2d229d2fd4fc7e8636142ec5d0ff0bc031f14c15b682e2ac01dfd5b5138",
  },
  {
    packages: ["@uiw/react-json-view@2.0.0-alpha.41"],
    repository: "uiwjs/react-json-view", license: "MIT", file: "uiw-react-json-view.txt",
    upstream: "uiwjs/react-json-view/4685111ae16e3ec6d6d543c2db0b5009b5142eae/LICENSE",
    hash: "d6c29a4acc00299dddc5ffb5d07a6480c1ddcc73adf3ade50743988b13c43808",
  },
  {
    packages: ["ansi-to-react@6.2.6"],
    repository: "nteract/ansi-to-react", license: "BSD-3-Clause", file: "ansi-to-react.txt",
    // The original monorepo is now archived-desktop-app. Its 6.0.3 npm
    // gitHead contains packages/ansi-to-react and this root license. Standalone
    // commit f37e277c4402038456ebb120d8ec9c10335a4959 migrates that package;
    // 6.2.6 still declares BSD-3-Clause but omits the inherited full notice.
    upstream: "nteract/archived-desktop-app/d58b7ba291f5902c5ea36f78462d4bc607ea6f0d/LICENSE",
    hash: "866e6fa48cb8810d36d8d85a3085d7aa1c4317d3731f0ef84919428fee87bf71",
  },
  {
    packages: ["react-remove-scroll-bar@2.3.8"],
    repository: "theKashey/react-remove-scroll-bar", license: "MIT", file: "react-remove-scroll-bar.txt",
    // Upstream's explicit license clarification merged after 2.3.8. The npm
    // gitHead is unavailable; preserve upstream's actual notice, not an inferred
    // copyright year. Package repository, author and MIT selection agree.
    upstream: "theKashey/react-remove-scroll-bar/8ca9ba5ea52de03308fe8ced94f7b159a44d28ff/LICENSE",
    hash: "a79aae0c0f21990d9d963bb3c5a79cdcea9a46f8523ba55c58d7fe776b6ebc84",
  },
  {
    packages: ["rehype-katex@7.0.1"],
    repository: "remarkjs/remark-math", license: "MIT", file: "rehype-katex.txt",
    upstream: "remarkjs/remark-math/88a9497e1ede93b958237c85edbf5651faeca7af/license",
    hash: "cb992262f361a5359e6771c28740d33c7041e15332ae8537fae40538992591a9",
  },
  {
    packages: ["remark-math@6.0.0"],
    repository: "remarkjs/remark-math", license: "MIT", file: "remark-math.txt",
    upstream: "remarkjs/remark-math/d5d0660b150810a535bbb07eac6cc96a4510aa24/license",
    hash: "cb992262f361a5359e6771c28740d33c7041e15332ae8537fae40538992591a9",
  },
  // Vega's root release script explicitly copies ../../LICENSE into packages.
  // The functions commit is its reviewed 6.1.1 version bump (npm has no gitHead);
  // interpreter and selections use their npm gitHeads.
  ...[
    ["vega-functions@6.1.1", "d8add5819346e5af597d82ef8253742acc0283ba"],
    ["vega-interpreter@2.2.1", "ce060407bf65acbe9eb07004f08ac5b4bc8b7108"],
    ["vega-selections@6.1.2", "7514fd2ad718646ac6cc9ace2beefe1577c85f78"],
  ].map(([name, revision]) => ({
    packages: [name], repository: "vega/vega", license: "BSD-3-Clause",
    file: `${name.split("@")[0]}.txt`, upstream: `vega/vega/${revision}/LICENSE`,
    hash: "63727832aaf62004a2b249c933e327f3c90caf49e41a72f4bf436edf632cbda8",
  })),
];

async function prepare(check) {
  const store = join(root, "node_modules/.pnpm");
  const entries = await readdir(store);
  const packages = {};
  const notices = [];
  for (const source of sources) {
    const noticePath = `npm-missing/${source.file}`;
    const url = raw + source.upstream;
    let bytes;
    if (check) {
      bytes = await readFile(join(destination, noticePath));
    } else {
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`${response.status}: ${url}`);
      bytes = Buffer.from(await response.arrayBuffer());
    }
    assert.ok(new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim(), `Empty notice: ${url}`);
    assert.equal(sha256(bytes), source.hash, `Unreviewed upstream license bytes: ${url}`);
    notices.push([noticePath, bytes]);
    for (const identity of source.packages) {
      const name = identity.slice(0, identity.lastIndexOf("@"));
      const prefix = identity.replace("/", "+");
      const matches = entries.filter((entry) => entry === prefix || entry.startsWith(`${prefix}_`));
      assert.ok(matches.length, `Missing installed reviewed package: ${identity}`);
      let manifestHash;
      for (const entry of matches) {
        const manifestBytes = await readFile(join(store, entry, "node_modules", name, "package.json"));
        const manifest = JSON.parse(manifestBytes);
        assert.equal(`${manifest.name}@${manifest.version}`, identity);
        assert.equal(manifest.license, source.license, `Unreviewed license selection: ${identity}`);
        const repository = typeof manifest.repository === "string" ? manifest.repository : manifest.repository?.url;
        assert.ok(repository?.includes(`github.com/${source.repository}`), `Unreviewed repository: ${identity}`);
        const hash = sha256(manifestBytes);
        if (manifestHash) assert.equal(hash, manifestHash, `Divergent peer copies: ${identity}`);
        manifestHash = hash;
      }
      assert.ok(!packages[identity], `Duplicate reviewed package: ${identity}`);
      packages[identity] = {
        files: { "package.json": manifestHash },
        covers: ["full-license"],
        notices: [{ path: noticePath, sha256: source.hash, source: url }],
      };
    }
  }
  const output = `${JSON.stringify({ schemaVersion: 1, packages: Object.fromEntries(Object.entries(packages).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) }, null, 2)}\n`;
  const manifestPath = join(destination, "npm-missing-supplement.json");
  if (check) {
    assert.equal(await readFile(manifestPath, "utf8"), output, "Supplement differs from reviewed inputs; inspect before regenerating");
  } else {
    // Validate every source before publishing any generated material.
    await mkdir(join(destination, "npm-missing"), { recursive: true });
    for (const [path, bytes] of notices) await writeFile(join(destination, path), bytes);
    await writeFile(manifestPath, output);
  }
  console.log(`${check ? "Verified" : "Generated"} ${Object.keys(packages).length} exact package bindings and ${notices.length} nonempty upstream notices.`);
}

if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== "--check")) {
  throw new Error("Usage: node scripts/prepare-npm-license-supplements.mjs [--check]");
}
await prepare(process.argv[2] === "--check");
