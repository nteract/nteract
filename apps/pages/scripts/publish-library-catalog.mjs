// Publish a build's view library catalog to an R2 bucket that serves a
// library origin (PAGES_LIBRARY_ORIGIN, DEPLOYMENT.md "Library origin").
//
//   node scripts/publish-library-catalog.mjs <bucket> [--dist dist] [--dry-run]
//
// Every file of each revision under <dist>/public/catalog/ goes to
// catalog/<revision>/<file> with its content type and an immutable cache
// header. A revision names its bytes, so publishing one again writes the same
// objects. Uploads run through wrangler and its current login.
import { execFileSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { LIBRARY_REVISION } from "../shared/library-catalog.mjs";
import { LIBRARY_CATALOG_DIRECTORY, LIBRARY_FILE } from "./library-catalog.mjs";

const CONTENT_TYPES = Object.freeze({
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  wasm: "application/wasm",
  json: "application/json; charset=utf-8",
});
export const CATALOG_CACHE_CONTROL = "public, max-age=31536000, immutable";

/** The objects to upload for the catalogs in `dist`: {key, file, contentType},
 * manifest.json last in each revision, so a reader that finds a manifest finds
 * its files. Refuses a directory that is not a revision or a file the catalog
 * cannot hold. */
export async function catalogUploads(dist) {
  const root = path.join(dist, LIBRARY_CATALOG_DIRECTORY);
  const uploads = [];
  for (const revision of (await readdir(root)).sort()) {
    if (!LIBRARY_REVISION.test(revision))
      throw Error(`${root} holds ${revision}, which is not a catalog revision`);
    const names = (await readdir(path.join(root, revision))).sort((a, b) =>
      a === "manifest.json" ? 1 : b === "manifest.json" ? -1 : a.localeCompare(b, "en"),
    );
    for (const name of names) {
      if (!LIBRARY_FILE.test(name)) throw Error(`The library catalog cannot hold ${name}`);
      uploads.push({
        key: `catalog/${revision}/${name}`,
        file: path.join(root, revision, name),
        contentType: CONTENT_TYPES[name.split(".").at(-1)],
      });
    }
  }
  return uploads;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const dist = args.includes("--dist") ? args[args.indexOf("--dist") + 1] : "dist";
  const bucket = args.find(
    (arg, i) => !arg.startsWith("--") && !(args[i - 1] === "--dist" && arg === dist),
  );
  if (!bucket) {
    console.error(
      "usage: node scripts/publish-library-catalog.mjs <bucket> [--dist dist] [--dry-run]",
    );
    process.exit(2);
  }
  for (const { key, file, contentType } of await catalogUploads(dist)) {
    const command = [
      "wrangler",
      "r2",
      "object",
      "put",
      `${bucket}/${key}`,
      "--remote",
      `--file=${file}`,
      `--content-type=${contentType}`,
      `--cache-control=${CATALOG_CACHE_CONTROL}`,
    ];
    console.log(command.join(" "));
    if (!args.includes("--dry-run")) execFileSync("npx", command, { stdio: "inherit" });
  }
}
