// The local output host for celld development: the frame bootstrap on a
// loopback origin of its own, with a frame CSP that also admits the local
// Pages origin, where the page's library map points (local-frame-csp.mjs).
// It also serves a catalog build at /catalog/<revision>/. Only the frame and
// catalog files are exposed on this loopback listener.
//
//   PAGES_PORT=9916 node scripts/widget-catalog/serve.mjs
//
// PAGES_ORIGIN names the Pages origin outright; otherwise PAGES_HOST and
// PAGES_PORT give it, with the same defaults as scripts/dev.mjs.
// --build-only writes the catalog and prints its revision.
import { startCatalogServer } from "./server.mjs";
import { buildLibraryCatalog, writeLibraryCatalog } from "../library-catalog.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = fileURLToPath(new URL("../../", import.meta.url));
const dir = path.join(app, ".output-dist/catalog");
const port = Number(process.env.PAGES_CATALOG_PORT || 9446);
const origin = `http://127.0.0.1:${port}`;
const pagesOrigin =
  process.env.PAGES_ORIGIN ||
  `http://${process.env.PAGES_HOST || "localhost"}:${Number(process.env.PAGES_PORT || 9894)}`;
const catalog = await buildLibraryCatalog(app);
await writeLibraryCatalog(dir, catalog);
if (process.argv.includes("--build-only")) console.log(catalog.revision);
else startCatalogServer({ dir, pin: catalog.revision, origin, port, pagesOrigin });
