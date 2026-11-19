// A one-library catalog in a build's layout (scripts/library-catalog.mjs),
// for tests that stage or package a synthetic build.
import { createHash } from "node:crypto";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export const LIBRARY_MODULE = "export const shout = (s) => s.toUpperCase();\n";
export const LIBRARY_MANIFEST_TEXT =
  JSON.stringify(
    { imports: { shout: "shout.js" }, files: { "shout.js": sha256(LIBRARY_MODULE) } },
    null,
    2,
  ) + "\n";
export const LIBRARY_REVISION_FIXTURE = sha256(LIBRARY_MANIFEST_TEXT);

/** Each catalog file's dist path → its text. */
export const libraryCatalogContents = Object.freeze({
  [`public/catalog/${LIBRARY_REVISION_FIXTURE}/manifest.json`]: LIBRARY_MANIFEST_TEXT,
  [`public/catalog/${LIBRARY_REVISION_FIXTURE}/shout.js`]: LIBRARY_MODULE,
});
export const libraryCatalogFiles = Object.freeze(Object.keys(libraryCatalogContents).sort());

/** The build receipt's `library_catalog` for this catalog. */
export const libraryCatalogReceipt = () => ({
  revision: LIBRARY_REVISION_FIXTURE,
  files: Object.fromEntries(
    Object.entries(libraryCatalogContents).map(([file, text]) => [file, sha256(text)]),
  ),
});
