// Builds lib/THIRD_PARTY_NOTICES.md for the packed library. It covers the Rust
// crates compiled into lib/wasm and the npm packages inlined into lib/*.js.
// Externals stay out: consumers install those under their own licenses.
// Unknown licenses, missing texts and unexplained native sources fail the build.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

const flat = (text) => text.replace(/\s+/g, " ").trim();

// Licenses this file can reproduce, in preference order when a package offers
// a choice. Each pattern recognizes the license's full text after whitespace
// is collapsed, so pointer files ("dual-licensed under ...") don't count.
const LICENSES = [
  ["MIT", /Permission is hereby granted, free of charge, to any person obtaining a copy/],
  [
    "ISC",
    /Permission to use, copy, modify, (?:and\/or |and )?distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice/,
  ],
  ["BSD-3-Clause", /Redistribution and use in source and binary forms.*Neither the name/],
  ["BSD-2-Clause", /^(?!.*Neither the name).*Redistribution and use in source and binary forms/],
  ["Apache-2.0", /TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION/],
  ["Zlib", /This software is provided 'as-is', without any express or implied warranty/],
  [
    "0BSD",
    /Permission to use, copy, modify, and\/or distribute this software for any purpose with or without fee is hereby granted\./,
  ],
  ["Unicode-3.0", /UNICODE LICENSE V3/],
  ["BSL-1.0", /Boost Software License - Version 1\.0/],
  ["Unlicense", /This is free and unencumbered software released into the public domain/],
];
const LICENSE_ORDER = LICENSES.map(([id]) => id);
const LICENSE_TEXT = new Map(LICENSES);

// Crates that compile foreign sources into the module, and those sources' terms.
const NATIVE_SOURCES = {
  "zstd-sys": { name: "Zstandard", license: "BSD-3-Clause", file: "zstd/LICENSE" },
};
// `-sys` crates that only bind JavaScript APIs and compile nothing else.
const BINDING_ONLY = new Set(["js-sys", "web-sys"]);

const MIT_TERMS = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

/** Parses an SPDX expression, including Cargo's legacy `MIT/Apache-2.0` form. */
export function parseLicenseExpression(expression) {
  const tokens = expression.replaceAll("/", " OR ").match(/[()]|[^\s()]+/g) ?? [];
  let position = 0;
  const fail = () => {
    throw new Error(`Unsupported license expression: ${JSON.stringify(expression)}`);
  };
  const primary = () => {
    const token = tokens[position++];
    if (token === "(") {
      const node = disjunction();
      if (tokens[position++] !== ")") fail();
      return node;
    }
    if (!token || ["AND", "OR", "WITH", ")"].includes(token)) fail();
    if (tokens[position] !== "WITH") return { id: token };
    position += 1;
    const exception = tokens[position++];
    if (!exception || ["AND", "OR", "WITH", "(", ")"].includes(exception)) fail();
    return { id: `${token} WITH ${exception}` };
  };
  const conjunction = () => {
    const terms = [primary()];
    while (tokens[position] === "AND") {
      position += 1;
      terms.push(primary());
    }
    return terms.length === 1 ? terms[0] : { and: terms };
  };
  const disjunction = () => {
    const options = [conjunction()];
    while (tokens[position] === "OR") {
      position += 1;
      options.push(conjunction());
    }
    return options.length === 1 ? options[0] : { or: options };
  };
  const node = disjunction();
  if (position !== tokens.length) fail();
  return node;
}

/**
 * The licenses this package is used under. Among alternatives, take the one
 * whose texts the package ships, then the earlier license in LICENSE_ORDER.
 */
export function chooseLicenses(expression, shipped = new Set()) {
  const rank = (id) => (LICENSE_TEXT.has(id) ? LICENSE_ORDER.indexOf(id) : Infinity);
  const visit = (node) => {
    if (node.id) return [node.id];
    if (node.and) return node.and.flatMap(visit);
    const options = node.or.map(visit).map((ids) => ({
      ids,
      unknown: ids.some((id) => rank(id) === Infinity),
      missing: ids.filter((id) => !shipped.has(id)).length,
      worst: Math.max(...ids.map(rank)),
    }));
    options.sort((a, b) => a.unknown - b.unknown || a.missing - b.missing || a.worst - b.worst);
    return options[0].ids;
  };
  return [...new Set(visit(parseLicenseExpression(expression)))];
}

function readText(path) {
  return readFileSync(path, "utf8").replace(/\r\n?/g, "\n").trim();
}

/** Top-level license, copying, notice and copyright files, plus REUSE `LICENSES/`. */
export function licenseFiles(directory) {
  const files = [];
  const add = (name, path) => {
    if (statSync(path).isFile()) files.push({ name, text: readText(path) });
  };
  for (const name of readdirSync(directory).sort()) {
    if (/^(licen[cs]e|copying|notice|copyright|unlicense)/i.test(name)) {
      add(name, join(directory, name));
    }
  }
  const reuse = join(directory, "LICENSES");
  if (existsSync(reuse) && statSync(reuse).isDirectory()) {
    for (const name of readdirSync(reuse).sort()) add(`LICENSES/${name}`, join(reuse, name));
  }
  return files;
}

const isNotice = (file) => /^notice/i.test(file.name);

// Copyright statements, not license prose that wraps onto a line starting with
// "copyright" or the Apache appendix's "Copyright [yyyy]" placeholder.
function copyrightLines(files) {
  const lines = files
    .filter((file) => !isNotice(file))
    .flatMap((file) => file.text.split("\n"))
    .map((line) => line.trim())
    .filter((line) => /^Copyright\s+(?:\([cC]\)|©|\d|[A-Z])/.test(line));
  return [...new Set(lines)];
}

/**
 * License texts for one package. An Apache-2.0 entry in `texts` has a null
 * `text` when the package doesn't ship it; the shared Apache text covers it.
 */
export function packageNotice(entry) {
  const label = `${entry.name} ${entry.version}`;
  if (!entry.declared) throw new Error(`${label} declares no license`);
  const files = licenseFiles(entry.directory);
  const shipped = new Set(
    LICENSE_ORDER.filter((id) => files.some((file) => LICENSE_TEXT.get(id).test(flat(file.text)))),
  );
  const licenses = chooseLicenses(entry.declared, shipped);
  const texts = [];
  for (const license of licenses) {
    if (!LICENSE_TEXT.has(license)) {
      throw new Error(
        `${label} is licensed ${entry.declared}. Review ${license} before Sift ships it, then teach scripts/third-party-notices.mjs its text.`,
      );
    }
    const file = files.find((candidate) => LICENSE_TEXT.get(license).test(flat(candidate.text)));
    if (license === "Apache-2.0") {
      texts.push({ license, text: file?.text ?? null });
    } else if (file) {
      texts.push({ license, text: file.text });
    } else if (license === "MIT") {
      // The package declares MIT without its text: state the standard terms
      // with the copyright lines it ships, or the authors its manifest lists.
      const holders = copyrightLines(files);
      const owners =
        holders.length > 0
          ? holders
          : [`Copyright (c) ${entry.authors || `the ${entry.name} authors`}`];
      texts.push({
        license,
        text: `MIT License\n\n${owners.join("\n")}\n\n${MIT_TERMS}`,
        generated: true,
      });
    } else {
      throw new Error(`${label} declares ${license} but ships no ${license} text`);
    }
  }
  return {
    ...entry,
    label,
    licenses,
    texts,
    notices: files.filter(isNotice).map((file) => file.text),
    copyrights: licenses.includes("Apache-2.0") ? copyrightLines(files) : [],
  };
}

function insideRepository(path) {
  const relation = relative(repoRoot, path);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

function firstPartyDirectory(path) {
  const parts = relative(repoRoot, path).split(/[\\/]/);
  return ["apps", "crates", "packages", "plugins", "python"].includes(parts[0]) && parts.length > 2
    ? `${parts[0]}/${parts[1]}`
    : parts[0];
}

function authorsOf(manifest) {
  const people = [manifest.author, ...(manifest.contributors ?? [])].filter(Boolean);
  return people
    .map((person) => (typeof person === "string" ? person : person.name))
    .filter(Boolean)
    .map((person) => person.replace(/\s*[<(].*$/, ""))
    .join(", ");
}

/**
 * Packages behind the modules a bundle rendered. Modules under node_modules
 * belong to the package after the last `node_modules/`; repository sources
 * (Sift, shared UI primitives, workspace packages) are first-party.
 */
export function bundledPackages(moduleIds) {
  const roots = new Map();
  const firstParty = new Set();
  for (const id of moduleIds) {
    // `\0` ids are bundler runtime helpers, not package sources.
    if (id.startsWith("\0")) continue;
    const file = id.split("?")[0].replaceAll("\\", "/");
    const marker = file.lastIndexOf("/node_modules/");
    if (marker >= 0) {
      const start = marker + "/node_modules/".length;
      const parts = file.slice(start).split("/");
      const name = parts[0].startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
      roots.set(file.slice(0, start) + name, name);
    } else if (isAbsolute(file) && insideRepository(file)) {
      firstParty.add(firstPartyDirectory(file));
    } else {
      throw new Error(`Bundled module is outside node_modules and this repository: ${id}`);
    }
  }
  const packages = new Map();
  for (const [directory, name] of roots) {
    const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
    if (manifest.name !== name)
      throw new Error(`Expected ${name} at ${directory}, found ${manifest.name}`);
    const declared =
      typeof manifest.license === "string"
        ? manifest.license
        : (manifest.licenses ?? []).map((license) => license.type ?? license).join(" OR ");
    packages.set(`${name}@${manifest.version}`, {
      name,
      version: manifest.version,
      declared,
      directory,
      authors: authorsOf(manifest),
    });
  }
  return {
    packages: [...packages.values()].sort(
      (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
    ),
    firstParty: [...firstParty].sort(),
  };
}

const CARGO_TREE = [
  "tree",
  "-p",
  "sift-wasm",
  "--target",
  "wasm32-unknown-unknown",
  "-e",
  "normal,no-proc-macro",
  "--prefix",
  "none",
  "--format",
  "{p}|{l}",
  "--locked",
];

function cargoAuthors(directory) {
  const manifest = readFileSync(join(directory, "Cargo.toml"), "utf8");
  const match = /^authors\s*=\s*\[([^\]]*)\]/m.exec(manifest);
  if (!match) return "";
  return [...match[1].matchAll(/"([^"]+)"/g)]
    .map((author) => author[1].replace(/\s*<[^>]*>/, ""))
    .join(", ");
}

/** Crates `cargo tree` reports for the WebAssembly build, with their unpacked sources. */
export function wasmCrates(
  tree = execFileSync(process.env.CARGO ?? "cargo", CARGO_TREE, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }),
) {
  const registry = join(process.env.CARGO_HOME ?? join(homedir(), ".cargo"), "registry", "src");
  const indexes = existsSync(registry)
    ? readdirSync(registry)
        .sort()
        .map((name) => join(registry, name))
    : [];
  const crates = new Map();
  const firstParty = new Set();
  for (const line of tree.split("\n")) {
    if (!line.trim()) continue;
    const match = /^(\S+) v(\S+)(?: \((.+?)\))?\|(.*?)(?: \(\*\))?$/.exec(line.trim());
    if (!match) throw new Error(`Unexpected cargo tree line: ${line}`);
    const [, name, version, source, declared] = match;
    if (source) {
      if (!isAbsolute(source) || !insideRepository(source)) {
        throw new Error(
          `${name} ${version} comes from ${source}; Sift's notices support crates.io and this repository only`,
        );
      }
      firstParty.add(firstPartyDirectory(join(source, "Cargo.toml")));
      continue;
    }
    if (crates.has(`${name}@${version}`)) continue;
    const directory = indexes
      .map((index) => join(index, `${name}-${version}`))
      .find((path) => existsSync(join(path, "Cargo.toml")));
    if (!directory) {
      throw new Error(
        `Missing unpacked source for crate ${name} ${version}. Build the WASM first: cargo xtask wasm sift`,
      );
    }
    if (name.endsWith("-sys") && !NATIVE_SOURCES[name] && !BINDING_ONLY.has(name)) {
      throw new Error(
        `${name} may compile native sources into the WASM. Record their license in scripts/third-party-notices.mjs.`,
      );
    }
    crates.set(`${name}@${version}`, {
      name,
      version,
      declared,
      directory,
      authors: cargoAuthors(directory),
    });
  }
  const sorted = [...crates.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
  );
  const native = sorted
    .filter((crate) => NATIVE_SOURCES[crate.name])
    .map((crate) => {
      const source = NATIVE_SOURCES[crate.name];
      const path = join(crate.directory, source.file);
      if (!existsSync(path))
        throw new Error(`${crate.name} ${crate.version} no longer ships ${source.file}`);
      const text = readText(path);
      if (!LICENSE_TEXT.get(source.license).test(flat(text))) {
        throw new Error(`${crate.name} ${crate.version}: ${source.file} is not ${source.license}`);
      }
      return {
        name: source.name,
        via: `${crate.name} ${crate.version}`,
        license: source.license,
        text,
      };
    });
  return { crates: sorted, native, firstParty: [...firstParty].sort() };
}

function fence(text) {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((run) => run[0].length));
  const marks = "`".repeat(longest + 1);
  return `${marks}text\n${text}\n${marks}`;
}

const cell = (value) => String(value).replaceAll("|", "\\|");
const table = (header, rows) =>
  [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
  ].join("\n");

function grouped(items) {
  const groups = new Map();
  for (const { key, value, label } of items) {
    if (!groups.has(key)) groups.set(key, { value, labels: [] });
    groups.get(key).labels.push(label);
  }
  return [...groups.values()];
}

const digest = (value) => createHash("sha256").update(value).digest("hex");

/** Renders the notices document. Output depends only on its inputs. */
export function renderNotices({ crates, native, packages, firstParty }) {
  const entries = [
    ...crates.map((crate) => ({ ...crate, kind: "crate" })),
    ...packages.map((pkg) => ({ ...pkg, kind: "npm" })),
  ].map((entry) => ({ ...packageNotice(entry), kind: entry.kind }));
  const apacheUsers = entries.filter((entry) => entry.licenses.includes("Apache-2.0"));
  const apacheTexts = grouped(
    apacheUsers.flatMap((entry) =>
      entry.texts
        .filter((text) => text.license === "Apache-2.0" && text.text)
        .map((text) => ({ key: digest(flat(text.text)), value: text.text, label: entry.label })),
    ),
  ).sort((a, b) => b.labels.length - a.labels.length || a.labels[0].localeCompare(b.labels[0]));
  if (apacheUsers.length > 0 && apacheTexts.length === 0) {
    throw new Error("No package ships the Apache-2.0 text that its Apache-licensed packages need");
  }
  const sections = grouped(
    entries.flatMap((entry) =>
      entry.texts
        .filter((text) => text.license !== "Apache-2.0")
        .map((text) => ({
          key: digest(`${text.license}\n${flat(text.text)}`),
          value: text,
          label: text.generated
            ? `${entry.label} (declares MIT without shipping its text)`
            : entry.label,
        })),
    ),
  ).map(({ value, labels }) => ({ license: value.license, labels, text: value.text }));
  for (const source of native) {
    sections.push({
      license: source.license,
      labels: [`${source.name} (compiled by ${source.via})`],
      text: source.text,
    });
  }
  if (apacheTexts.length > 0) {
    sections.push({
      license: "Apache-2.0",
      labels: apacheUsers.map((entry) => entry.label),
      text: apacheTexts[0].value,
    });
  }
  sections.sort(
    (a, b) => a.license.localeCompare(b.license) || a.labels[0].localeCompare(b.labels[0]),
  );
  const notices = grouped(
    entries.flatMap((entry) =>
      entry.notices.map((text) => ({ key: digest(flat(text)), value: text, label: entry.label })),
    ),
  );
  const row = (entry) => [entry.name, entry.version, entry.licenses.join(" AND "), entry.declared];
  const header = ["Package", "Version", "License used", "Declared license"];
  const lines = [
    "# Third-party notices for @nteract/sift",
    "",
    "`@nteract/sift` is distributed under the BSD-3-Clause license in `LICENSE`.",
    "That license also covers the first-party sources it builds from the nteract",
    `repository: ${[...new Set([...firstParty.crates, ...firstParty.packages])]
      .sort()
      .map((path) => `\`${path}\``)
      .join(", ")}.`,
    "",
    "The rest of this file covers third-party code in the package:",
    "",
    "- `wasm/sift_wasm_bg.wasm` and `wasm/sift_wasm.js` compile the Rust crates and",
    "  C sources below, as reported by",
    `  \`cargo ${CARGO_TREE.slice(0, 7).join(" ")}\`.`,
    "- `index.js` and `handoff.js` inline the npm packages below. Dependencies",
    "  that consumers install, such as React and Radix UI, are not part of the package.",
    "",
    "Where a package offers a choice of licenses, this package uses one whose text",
    `the package ships, preferring ${LICENSE_ORDER.join(", ")} in that order.`,
    "",
    "## Rust crates in the WebAssembly module",
    "",
    table(header, entries.filter((entry) => entry.kind === "crate").map(row)),
    "",
  ];
  if (native.length > 0) {
    lines.push(
      "## C sources in the WebAssembly module",
      "",
      table(
        ["Source", "Compiled by", "License used"],
        native.map((source) => [source.name, source.via, source.license]),
      ),
      "",
    );
  }
  lines.push(
    "## npm packages inlined into the JavaScript",
    "",
    table(header, entries.filter((entry) => entry.kind === "npm").map(row)),
    "",
    "## License texts",
    "",
  );
  for (const section of sections) {
    lines.push(`### ${section.license}: ${section.labels.join(", ")}`, "", fence(section.text), "");
  }
  if (apacheUsers.length > 0) {
    lines.push("## Apache-2.0 copyright notices", "");
    for (const entry of apacheUsers) {
      const notice =
        entry.copyrights.length > 0
          ? entry.copyrights.join("; ")
          : entry.notices.length > 0
            ? "see its NOTICE below"
            : `authors: ${entry.authors || "not listed"}`;
      lines.push(`- ${entry.label}: ${notice}`);
    }
    lines.push("");
  }
  if (notices.length > 0) {
    lines.push("## NOTICE files", "");
    for (const notice of notices)
      lines.push(`### ${notice.labels.join(", ")}`, "", fence(notice.value), "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/** Writes the notices for a finished library build. */
export async function writeThirdPartyNotices({ moduleIds, output }) {
  const wasm = wasmCrates();
  const bundle = bundledPackages(moduleIds);
  const document = renderNotices({
    crates: wasm.crates,
    native: wasm.native,
    packages: bundle.packages,
    firstParty: { crates: wasm.firstParty, packages: bundle.firstParty },
  });
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, document);
  return document;
}
