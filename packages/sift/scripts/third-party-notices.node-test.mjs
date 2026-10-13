import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  bundledPackages,
  chooseLicenses,
  packageNotice,
  renderNotices,
  repoRoot,
  wasmCrates,
} from "./third-party-notices.mjs";

const MIT = `MIT License

Copyright (c) 2024 Example Authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software").`;
const APACHE = `Apache License
Version 2.0, January 2004

TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

1. Definitions. "License" shall mean the terms and conditions for use,
copyright notice that is included in or attached to the work.

END OF TERMS AND CONDITIONS`;
const BSD = `Copyright 2011, The Example Authors.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:
Neither the name of the copyright holder nor the names of its contributors.`;

function scratch(run) {
  const directory = mkdtempSync(join(tmpdir(), "sift-notices-"));
  try {
    return run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function fixture(directory, files) {
  mkdirSync(directory, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(directory, name, ".."), { recursive: true });
    writeFileSync(join(directory, name), text);
  }
  return directory;
}

test("license choice prefers shipped texts, then the preference order", () => {
  const both = new Set(["MIT", "Apache-2.0"]);
  assert.deepEqual(chooseLicenses("MIT OR Apache-2.0", both), ["MIT"]);
  assert.deepEqual(chooseLicenses("Apache-2.0/MIT", both), ["MIT"]);
  assert.deepEqual(chooseLicenses("MIT OR Apache-2.0", new Set(["Apache-2.0"])), ["Apache-2.0"]);
  assert.deepEqual(chooseLicenses("Apache-2.0 OR BSL-1.0", both), ["Apache-2.0"]);
  assert.deepEqual(chooseLicenses("(MIT OR Apache-2.0) AND Unicode-3.0", both), [
    "MIT",
    "Unicode-3.0",
  ]);
  assert.deepEqual(chooseLicenses("GPL-3.0-only OR MIT"), ["MIT"]);
  assert.deepEqual(chooseLicenses("Apache-2.0 WITH LLVM-exception"), [
    "Apache-2.0 WITH LLVM-exception",
  ]);
  for (const malformed of ["", "MIT OR", "(MIT", "MIT)", "MIT AND OR ISC", "MIT WITH"]) {
    assert.throws(() => chooseLicenses(malformed), /Unsupported license expression/);
  }
});

test("package notices use shipped texts and fail closed", () => {
  scratch((directory) => {
    const entry = (name, declared, files, authors = "") => ({
      name,
      version: "1.0.0",
      declared,
      authors,
      directory: fixture(join(directory, name), files),
    });
    const mit = packageNotice(entry("mit", "MIT", { LICENSE: MIT }));
    assert.deepEqual(mit.texts, [{ license: "MIT", text: MIT }]);

    // An Apache text beats a template for the MIT alternative.
    const dual = packageNotice(entry("dual", "MIT OR Apache-2.0", { "LICENSE-APACHE": APACHE }));
    assert.deepEqual(dual.licenses, ["Apache-2.0"]);
    assert.deepEqual(dual.copyrights, []);

    // Declared MIT without its text keeps the copyright lines the package ships.
    const pointer = packageNotice(
      entry("pointer", "MIT/Apache-2.0", {
        COPYING:
          "Copyright 2016 Frank Example.\n\nLicensed under Apache-2.0 or MIT, at your option.",
      }),
    );
    assert.equal(pointer.texts[0].generated, true);
    assert.match(
      pointer.texts[0].text,
      /^MIT License\n\nCopyright 2016 Frank Example\.\n\nPermission/,
    );
    const unlisted = packageNotice(entry("unlisted", "MIT", {}, "Ada Example"));
    assert.match(unlisted.texts[0].text, /Copyright \(c\) Ada Example/);

    const apache = packageNotice(
      entry("apache", "Apache-2.0", { NOTICE: "Apache Example\nCopyright 2020" }),
    );
    assert.deepEqual(apache.texts, [{ license: "Apache-2.0", text: null }]);
    assert.deepEqual(apache.notices, ["Apache Example\nCopyright 2020"]);

    assert.throws(() => packageNotice(entry("gpl", "GPL-3.0-only", {})), /Review GPL-3\.0-only/);
    assert.throws(
      () => packageNotice(entry("bsd", "BSD-3-Clause", {})),
      /ships no BSD-3-Clause text/,
    );
    assert.throws(() => packageNotice(entry("none", "", {})), /declares no license/);
  });
});

test("bundled modules map to packages after the last node_modules", () => {
  scratch((directory) => {
    const store = join(directory, "node_modules/.pnpm");
    const rxjs = fixture(join(store, "rxjs@7.8.2/node_modules/rxjs"), {
      "package.json": JSON.stringify({ name: "rxjs", version: "7.8.2", license: "Apache-2.0" }),
    });
    const scoped = fixture(join(store, "@scope+pkg@1.0.0/node_modules/@scope/pkg"), {
      "package.json": JSON.stringify({
        name: "@scope/pkg",
        version: "1.0.0",
        licenses: [{ type: "MIT" }, { type: "Apache-2.0" }],
        author: { name: "Grace Example", email: "grace@example.com" },
      }),
    });
    const result = bundledPackages([
      "\0rolldown/runtime.js",
      `${rxjs}/dist/esm5/internal/Observable.js`,
      `${rxjs}/dist/esm5/operators/index.js?commonjs-proxy`,
      `${scoped}/dist/index.js`,
      `${repoRoot}packages/sift/src/index.ts`,
      `${repoRoot}packages/odometer/src/index.ts`,
      `${repoRoot}src/components/ui/button.tsx`,
    ]);
    assert.deepEqual(
      result.packages.map(({ name, version, declared, authors }) => ({
        name,
        version,
        declared,
        authors,
      })),
      [
        {
          name: "@scope/pkg",
          version: "1.0.0",
          declared: "MIT OR Apache-2.0",
          authors: "Grace Example",
        },
        { name: "rxjs", version: "7.8.2", declared: "Apache-2.0", authors: "" },
      ],
    );
    assert.deepEqual(result.firstParty, ["packages/odometer", "packages/sift", "src"]);
    assert.throws(
      () => bundledPackages([join(directory, "vendor/loose.js")]),
      /outside node_modules/,
    );
  });
});

test("WASM crates come from the registry; unexplained native sources fail", () => {
  scratch((directory) => {
    const previous = process.env.CARGO_HOME;
    process.env.CARGO_HOME = directory;
    try {
      const registry = join(directory, "registry/src/index.example");
      for (const [name, files] of [
        ["serde-1.0.0", { "LICENSE-MIT": MIT }],
        ["js-sys-0.3.0", { "LICENSE-MIT": MIT }],
        ["zstd-sys-2.0.0+zstd.1.5.7", { "LICENSE-MIT": MIT, "zstd/LICENSE": BSD }],
        ["ring-sys-0.1.0", { "LICENSE-MIT": MIT }],
      ]) {
        fixture(join(registry, name), {
          "Cargo.toml": `[package]\nauthors = ["Ada Example <ada@example.com>"]\n`,
          ...files,
        });
      }
      const workspace = `sift-wasm v0.6.3 (${repoRoot}crates/sift-wasm)|BSD-3-Clause`;
      const result = wasmCrates(
        [
          workspace,
          "serde v1.0.0|MIT OR Apache-2.0",
          `nteract-predicate v0.6.3 (${repoRoot}crates/nteract-predicate)|BSD-3-Clause`,
          "serde v1.0.0|MIT OR Apache-2.0 (*)",
          "js-sys v0.3.0|MIT OR Apache-2.0",
          "zstd-sys v2.0.0+zstd.1.5.7|MIT/Apache-2.0",
          "",
        ].join("\n"),
      );
      assert.deepEqual(
        result.crates.map(({ name, version, authors }) => `${name} ${version} ${authors}`),
        [
          "js-sys 0.3.0 Ada Example",
          "serde 1.0.0 Ada Example",
          "zstd-sys 2.0.0+zstd.1.5.7 Ada Example",
        ],
      );
      assert.deepEqual(result.firstParty, ["crates/nteract-predicate", "crates/sift-wasm"]);
      assert.deepEqual(
        result.native.map(({ name, via, license }) => `${name} ${via} ${license}`),
        ["Zstandard zstd-sys 2.0.0+zstd.1.5.7 BSD-3-Clause"],
      );
      assert.throws(
        () => wasmCrates(`${workspace}\nring-sys v0.1.0|MIT`),
        /may compile native sources/,
      );
      assert.throws(
        () => wasmCrates("missing v9.9.9|MIT"),
        /Missing unpacked source for crate missing 9\.9\.9/,
      );
      assert.throws(
        () => wasmCrates("forked v1.0.0 (https://github.com/example/forked#abc123)|MIT"),
        /crates\.io and this repository only/,
      );
      assert.throws(() => wasmCrates("not a cargo tree line"), /Unexpected cargo tree line/);
    } finally {
      if (previous === undefined) delete process.env.CARGO_HOME;
      else process.env.CARGO_HOME = previous;
    }
  });
});

test("rendered notices share one Apache text, keep NOTICE files and are stable", () => {
  scratch((directory) => {
    const crate = (name, declared, files) => ({
      name,
      version: "1.0.0",
      declared,
      authors: "Crate Authors",
      directory: fixture(join(directory, name), files),
    });
    const input = {
      crates: [
        crate("arrow-like", "Apache-2.0", {
          "LICENSE.txt": APACHE,
          "NOTICE.txt": "Apache Arrow\nCopyright 2016",
        }),
        crate("thrift-like", "Apache-2.0", {}),
        crate("serde-like", "MIT OR Apache-2.0", { "LICENSE-MIT": MIT, "LICENSE-APACHE": APACHE }),
      ],
      native: [{ name: "Zstandard", via: "zstd-sys 2.0.0", license: "BSD-3-Clause", text: BSD }],
      packages: [crate("clsx-like", "MIT", { license: MIT })],
      firstParty: { crates: ["crates/sift-wasm"], packages: ["packages/sift"] },
    };
    const document = renderNotices(input);
    assert.equal(renderNotices(input), document);
    assert.equal(document.match(/TERMS AND CONDITIONS FOR USE/g).length, 1);
    assert.match(document, /### Apache-2\.0: arrow-like 1\.0\.0, thrift-like 1\.0\.0\n/);
    assert.match(document, /### MIT: serde-like 1\.0\.0, clsx-like 1\.0\.0\n/);
    assert.match(document, /### BSD-3-Clause: Zstandard \(compiled by zstd-sys 2\.0\.0\)\n/);
    assert.match(document, /- thrift-like 1\.0\.0: authors: Crate Authors\n/);
    assert.match(document, /- arrow-like 1\.0\.0: see its NOTICE below\n/);
    assert.match(document, /### arrow-like 1\.0\.0\n\n```text\nApache Arrow\nCopyright 2016\n```/);
    assert.match(document, /`crates\/sift-wasm`, `packages\/sift`/);
    assert.match(document, /\| serde-like \| 1\.0\.0 \| MIT \| MIT OR Apache-2\.0 \|/);

    assert.throws(
      () => renderNotices({ ...input, crates: [input.crates[1]], packages: [] }),
      /ships the Apache-2\.0 text/,
    );
  });
});
