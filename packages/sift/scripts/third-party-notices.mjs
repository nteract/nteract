// Writes lib/THIRD_PARTY_NOTICES.md for the Rust crates compiled into the
// shipped WebAssembly. cargo-about (about.toml) resolves the wasm32 dependency
// graph, license expressions, and license texts; this script adds the Apache
// NOTICE files cargo-about does not model and renders Markdown.
//
// The JavaScript bundle needs no entry here: every npm dependency is external
// (vite.lib.config.ts), so lib/*.js contains only first-party code.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageRoot, "../..");

/** @param {string} crate crate directory name under crates/ */
function aboutJson(crate) {
  const json = execFileSync(
    "cargo",
    [
      "about",
      "generate",
      "--format",
      "json",
      "--config",
      join(packageRoot, "about.toml"),
      "--manifest-path",
      join(repoRoot, "crates", crate, "Cargo.toml"),
      "--fail",
    ],
    { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  return JSON.parse(json);
}

/** NOTICE files next to a crate's manifest, as Apache-2.0 §4(d) asks us to carry. */
function noticeTexts(manifestPath) {
  const dir = dirname(manifestPath);
  return readdirSync(dir)
    .filter((name) => /^NOTICE(\.|$)/i.test(name))
    .sort()
    .map((name) => readFileSync(join(dir, name), "utf8").trim());
}

/**
 * C sources some crates compile into the WASM. cargo-about reports the Rust
 * bindings' license; the compiled C carries its own, read from the crate. A
 * crate that ships C/C++ sources and is not listed here fails generation.
 */
const BUNDLED_SOURCES = {
  "zstd-sys": { name: "Zstandard", licenseFile: "zstd/LICENSE", license: "BSD-3-Clause" },
};

/** Whether a crate directory contains C or C++ sources (what `cc` would compile). */
function shipsNativeSources(manifestPath) {
  const stack = [dirname(manifestPath)];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) stack.push(join(dir, entry.name));
      else if (/\.(c|cc|cpp|cxx)$/i.test(entry.name)) return true;
    }
  }
  return false;
}

/**
 * @param {string[]} crates crate directory names under crates/
 * @returns {string} Markdown
 */
export function renderNotices(crates) {
  /** @type {Map<string, {name:string, version:string, license:string, repository:string|null, notices:string[], modules:Set<string>}>} */
  const shipped = new Map();
  /** @type {Map<string, {id:string, name:string, text:string, users:Set<string>}>} */
  const licenses = new Map();

  for (const crate of crates) {
    const report = aboutJson(crate);
    for (const { package: pkg, license } of report.crates) {
      // Workspace members have no registry source; they are first-party.
      if (!pkg.source) continue;
      const key = `${pkg.name}@${pkg.version}`;
      const entry = shipped.get(key) ?? {
        name: pkg.name,
        version: pkg.version,
        license,
        repository: pkg.repository ?? null,
        notices: noticeTexts(pkg.manifest_path),
        modules: new Set(),
      };
      entry.modules.add(crate);
      shipped.set(key, entry);

      if (shipsNativeSources(pkg.manifest_path)) {
        const bundled = BUNDLED_SOURCES[pkg.name];
        if (!bundled) {
          throw new Error(
            `${key} ships C/C++ sources whose license is not reviewed. Add it to BUNDLED_SOURCES in ${fileURLToPath(import.meta.url)}.`,
          );
        }
        const path = join(dirname(pkg.manifest_path), bundled.licenseFile);
        const text = readFileSync(path, "utf8").trim();
        const licenseEntry = licenses.get(text) ?? {
          id: bundled.license,
          name: `${bundled.name} (C sources compiled by ${pkg.name})`,
          text,
          users: new Set(),
        };
        licenseEntry.users.add(`${bundled.name} via ${key}`);
        licenses.set(text, licenseEntry);
      }
    }
    for (const group of report.licenses) {
      const text = group.text.trim();
      const entry = licenses.get(text) ?? {
        id: group.id,
        name: group.name,
        text,
        users: new Set(),
      };
      for (const { crate: pkg } of group.used_by) {
        if (pkg.source) entry.users.add(`${pkg.name}@${pkg.version}`);
      }
      licenses.set(text, entry);
    }
  }

  const byName = (a, b) =>
    a.name.localeCompare(b.name, "en") || a.version.localeCompare(b.version, "en");
  const rows = [...shipped.values()].sort(byName);
  const lines = [
    "# Third-party notices",
    "",
    "This package ships WebAssembly compiled from the Rust crates below, under",
    "the licenses listed. The JavaScript in `lib/` is first-party; its npm",
    "dependencies are installed separately and carry their own licenses.",
    "",
    `Generated by \`cargo about\` from \`about.toml\` for ${crates.join(" and ")}.`,
    "",
    "## Crates",
    "",
    "| Crate | Version | License | Source |",
    "| --- | --- | --- | --- |",
    ...rows.map(
      (c) => `| ${c.name} | ${c.version} | ${c.license} | ${c.repository ?? "crates.io"} |`,
    ),
    "",
  ];

  // The Arrow crates share one NOTICE verbatim; print each distinct text once.
  /** @type {Map<string, string[]>} */
  const noticeGroups = new Map();
  for (const c of rows) {
    for (const text of c.notices) {
      const users = noticeGroups.get(text) ?? [];
      users.push(`${c.name} ${c.version}`);
      noticeGroups.set(text, users);
    }
  }
  if (noticeGroups.size > 0) {
    lines.push("## NOTICE files", "");
    for (const [text, users] of noticeGroups) {
      lines.push(`### ${users.join(", ")}`, "", "```", text, "```", "");
    }
  }

  lines.push("## License texts", "");
  const groups = [...licenses.values()].sort(
    (a, b) => a.id.localeCompare(b.id, "en") || a.text.localeCompare(b.text, "en"),
  );
  for (const g of groups) {
    const users = [...g.users].sort((a, b) => a.localeCompare(b, "en"));
    lines.push(
      `### ${g.name} (${g.id})`,
      "",
      `Used by: ${users.join(", ")}`,
      "",
      "```",
      g.text,
      "```",
      "",
    );
  }
  return lines.join("\n");
}

// Usage: node third-party-notices.mjs <output.md> <crate> [crate...]
// Shared by @nteract/sift (sift-wasm) and @nteract/sift-csv (sift-csv-wasm).
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [output, ...crates] = process.argv.slice(2);
  if (!output || crates.length === 0) {
    console.error("usage: third-party-notices.mjs <output.md> <crate> [crate...]");
    process.exit(2);
  }
  try {
    execFileSync("cargo", ["about", "--version"], { stdio: "ignore" });
  } catch {
    console.error(
      "cargo-about is required: cargo binstall cargo-about (or cargo install cargo-about)",
    );
    process.exit(1);
  }
  for (const crate of crates) {
    if (!existsSync(join(repoRoot, "crates", crate, "Cargo.toml"))) {
      console.error(`no such crate: crates/${crate}`);
      process.exit(2);
    }
  }
  mkdirSync(dirname(resolve(output)), { recursive: true });
  const markdown = renderNotices(crates);
  writeFileSync(resolve(output), `${markdown}\n`);
  const crateCount = (markdown.match(/^\| [^|]+ \| \d/gm) ?? []).length;
  console.log(`Wrote ${output} (${crateCount} crates from ${crates.join(", ")})`);
}
