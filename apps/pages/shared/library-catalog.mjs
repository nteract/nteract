// The view library catalog this build carries (scripts/library-catalog.mjs).
//
// scripts/build.mjs builds the catalog into public/catalog/<revision>/ and
// defines __PAGES_LIBRARY_CATALOG__ as that revision in both the Worker and
// the viewer bundle, beside the build id (shared/build-identity.mjs). A view
// that becomes or stays executable records it as catalog_revision when it is
// saved (model/view-doc.mjs setView). The viewer loads a view's pinned
// revision from this origin, and this one when the host doesn't serve the pin
// (viewer/library-catalog.mjs).
//
// Unbundled code (unit tests, tsx) has no catalog build. It reports
// UNBUILT_LIBRARY_CATALOG, a well-formed revision that no host serves.

/** A catalog revision: the sha256 of its manifest's text, in hex. */
export const LIBRARY_REVISION = /^[a-f0-9]{64}$/;
export const UNBUILT_LIBRARY_CATALOG = "0".repeat(64);

/* global __PAGES_LIBRARY_CATALOG__ */
export const LIBRARY_CATALOG_REVISION =
  typeof __PAGES_LIBRARY_CATALOG__ === "string" && LIBRARY_REVISION.test(__PAGES_LIBRARY_CATALOG__)
    ? __PAGES_LIBRARY_CATALOG__
    : UNBUILT_LIBRARY_CATALOG;

/** One catalog file's path without its leading slash, as a regular
 * expression source that JavaScript and the tunnel's ingress rules
 * (scripts/deployment/routes.mjs) both read: catalog/<revision>/<name>. Its
 * one group is the extension. */
export const LIBRARY_ROUTE = "catalog/[a-f0-9]{64}/[A-Za-z0-9_-]+[.](js|css|wasm|json)";
/** The path of one catalog file: /catalog/<revision>/<name>. */
export const LIBRARY_PATH = new RegExp(`^/${LIBRARY_ROUTE}$`);
export const libraryPath = (revision, name) => `/catalog/${revision}/${name}`;
