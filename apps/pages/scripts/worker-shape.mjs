// The part of the Wrangler configuration that the Worker's code decides. The
// celld build (build.mjs) and the Cloudflare package (cloudflare-stage.mjs)
// both spread it, so a new Durable Object class, migration or cron reaches
// both. What differs per runtime or deployment stays with each caller: the
// Worker's name, the entry path, and which D1 databases, R2 bucket and
// variables the bindings point at.
import { CRONS } from "../shared/schedule.mjs";

export function workerShape() {
  return {
    no_bundle: true,
    compatibility_date: "2026-10-01",
    assets: {
      directory: "public",
      binding: "ASSETS",
      not_found_handling: "single-page-application",
      run_worker_first: true,
    },
    durable_objects: {
      bindings: [
        { name: "PAGES", class_name: "Page" },
        { name: "CATALOGS", class_name: "Catalog" },
        // Declared and bound; nothing calls it (worker/page-records.mjs).
        { name: "PAGE_RECORDS", class_name: "PageRecords" },
        // Projects keep the Space class: the class name is the storage identity for
        // Projects, and celld 0.6.3 refuses renamed_classes migrations.
        { name: "PROJECTS", class_name: "Space" },
      ],
    },
    migrations: [
      { tag: "v1", new_sqlite_classes: ["Page", "Catalog"] },
      { tag: "v2", new_sqlite_classes: ["PageRecords"] },
      { tag: "v3", new_sqlite_classes: ["Space"] },
    ],
    triggers: { crons: [...CRONS] },
    // The Worker runs in server flow on every deployment.
    vars: { NOTEBOOK_CLOUD_OIDC_FLOW: "server" },
  };
}
