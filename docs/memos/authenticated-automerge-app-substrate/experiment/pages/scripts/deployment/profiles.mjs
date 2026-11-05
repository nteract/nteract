// Allowlisted isolated lab targets. Never accept arbitrary host, port or storage overrides.
// Official v0.6.3 Linux x86_64 executable (decompressed release asset).
// https://github.com/denoland/celld/releases/tag/v0.6.3
export const CELLD_RELEASE = Object.freeze({
  path: "/usr/local/bin/celld-v0.6.3",
  version: "celld 0.6.3",
  sha256: "eb0a8158421b69d68dd5d28f2298a7d411dde498295833deeb1cc5ce53b7eb75",
});

// Allocator diagnostics can precede --version on stdout. Require one complete
// release line rather than accepting a debug suffix or conflicting versions.
export function parseRuntimeVersion(output) {
  const lines =
    typeof output === "string"
      ? output.split(/\r?\n/).filter((line) => line.startsWith("celld "))
      : [];
  if (lines.length !== 1 || !/^celld (0|[1-9]\d*)[.](0|[1-9]\d*)[.](0|[1-9]\d*)$/.test(lines[0]))
    throw new Error("Expected exactly one canonical celld release version line");
  return lines[0];
}

// Inspect both the staged source and a service's private binary before writing
// anything. A later host rollout or same-version custom build needs an explicit
// new qualification rather than being silently replaced by an app deployment.
export function verifyRuntime(candidate, installed) {
  if (candidate?.version !== CELLD_RELEASE.version || candidate?.sha256 !== CELLD_RELEASE.sha256)
    throw new Error(`Expected the official ${CELLD_RELEASE.version} Linux x86_64 executable`);
  if (installed === undefined) return;
  if (installed.version === candidate.version) {
    if (installed.sha256 !== candidate.sha256)
      throw new Error(
        "Installed celld has the same version but a different build; qualify it before replacement",
      );
    return;
  }
  const parse = (version) => {
    const match = /^celld (0|[1-9]\d*)[.](0|[1-9]\d*)[.](0|[1-9]\d*)$/.exec(version ?? "");
    const parts = match?.slice(1).map(Number);
    return parts?.every(Number.isSafeInteger) ? parts : undefined;
  };
  const current = parse(installed.version);
  const next = parse(candidate.version);
  if (current) {
    for (let i = 0; i < next.length; i++) {
      if (current[i] < next[i]) return;
      if (current[i] > next[i]) break;
    }
  }
  throw new Error("Refusing to replace a newer or unrecognized celld runtime");
}

// The D1 database every build binds as DB (scripts/build.mjs). celld names its
// cell HMAC(D1 namespace, database_id), with no fleet input, so `cell` is the
// same on every fleet. A different database_id names a different database,
// which celld creates empty on first use; scripts/quota-rules.mjs refuses to
// run SQL unless `cell` is already listed in the target's bucket.
export const AUTH_D1 = Object.freeze({
  binding: "DB",
  database_name: "pages-next-auth",
  database_id: "pages-next-auth",
  cell: "__D1Database:c131e246b9200ef544cc9ae3b62b2878a6704bda1361a6c675d1f0fad09da941",
});

// celld creates this database on first use within each target's fleet prefix.
// Auth/catalog storage and usage history have independent identities.
export const USAGE_D1 = Object.freeze({
  binding: "PAGES_USAGE",
  database_name: "pages-usage",
  database_id: "pages-usage",
});
export const USAGE_CRON = "5 0 * * *";

const shared = {
  host: "lab1",
  bucket: "nteract-celld-lab-621741996708",
  region: "us-east-1",
  runtime: CELLD_RELEASE.path,
  requiredVersion: CELLD_RELEASE.version,
};
const DISABLED_MIGRATION = Object.freeze({ enabled: false, pageIds: Object.freeze([]) });
const targets = Object.freeze({
  "pages-next": Object.freeze({
    recordStorageMigration: DISABLED_MIGRATION,
    deployment: Object.freeze({
      host: shared.host,
      hostname: "pages-next.runtimed.run",
      service: "nteract-pages-next",
      bucket: shared.bucket,
      prefix: "standalone/pages-next",
      region: shared.region,
      listen: "127.0.0.1:9472",
      internalListen: "127.0.0.1:19472",
      runtime: shared.runtime,
      requiredVersion: shared.requiredVersion,
    }),
    firewallTable: "nteract_pages_next",
    firewallMark: "0x20000000",
    firewallComment: "nteract/preview-infra standalone-pages-next",
    asyncPersistence: false,
  }),
  page3: Object.freeze({
    recordStorageMigration: DISABLED_MIGRATION,
    deployment: Object.freeze({
      host: shared.host,
      hostname: "page3.runtimed.run",
      service: "nteract-page3",
      bucket: shared.bucket,
      prefix: "standalone/page3",
      region: shared.region,
      listen: "127.0.0.1:9473",
      internalListen: "127.0.0.1:19473",
      runtime: shared.runtime,
      requiredVersion: shared.requiredVersion,
    }),
    firewallTable: "nteract_page3",
    firewallMark: "0x10000000",
    firewallComment: "nteract/preview-infra standalone-page3",
    asyncPersistence: true,
    tunnelService: "cloudflared-page3.service",
  }),
  page4: Object.freeze({
    recordStorageMigration: DISABLED_MIGRATION,
    deployment: Object.freeze({
      host: shared.host,
      hostname: "page4.runtimed.run",
      service: "nteract-page4",
      bucket: shared.bucket,
      prefix: "standalone/page4",
      region: shared.region,
      listen: "127.0.0.1:9474",
      internalListen: "127.0.0.1:19474",
      runtime: shared.runtime,
      requiredVersion: shared.requiredVersion,
    }),
    firewallTable: "nteract_page4",
    firewallMark: "0x08000000",
    firewallComment: "nteract/preview-infra standalone-page4",
    asyncPersistence: true,
    editor: "wordgard",
    tunnelService: "cloudflared-page4.service",
    frozenTargets: Object.freeze(["pages-next", "page3"]),
  }),
  page5: Object.freeze({
    recordStorageMigration: DISABLED_MIGRATION,
    deployment: Object.freeze({
      host: shared.host,
      hostname: "page5.runtimed.run",
      service: "nteract-page5",
      bucket: shared.bucket,
      prefix: "standalone/page5",
      region: shared.region,
      listen: "127.0.0.1:9475",
      internalListen: "127.0.0.1:19475",
      runtime: shared.runtime,
      requiredVersion: shared.requiredVersion,
    }),
    sharing: true,
    firewallTable: "nteract_page5",
    firewallMark: "0x04000000",
    firewallComment: "nteract/preview-infra standalone-page5",
    asyncPersistence: true,
    editor: "wordgard",
    tunnelService: "cloudflared-page5.service",
    frozenTargets: Object.freeze(["pages-next", "page3", "page4"]),
  }),
  page6: Object.freeze({
    recordStorageMigration: DISABLED_MIGRATION,
    deployment: Object.freeze({
      host: shared.host,
      hostname: "page6.runtimed.run",
      service: "nteract-page6",
      bucket: shared.bucket,
      prefix: "standalone/page6",
      region: shared.region,
      listen: "127.0.0.1:9476",
      internalListen: "127.0.0.1:19476",
      runtime: shared.runtime,
      requiredVersion: shared.requiredVersion,
    }),
    sharing: true,
    firewallTable: "nteract_page6",
    firewallMark: "0x02000000",
    firewallComment: "nteract/preview-infra standalone-page6",
    asyncPersistence: true,
    editor: "wordgard",
    tunnelService: "cloudflared-page6.service",
    frozenTargets: Object.freeze(["pages-next", "page3", "page4", "page5"]),
  }),
  page7: Object.freeze({
    recordStorageMigration: DISABLED_MIGRATION,
    deployment: Object.freeze({
      host: shared.host,
      hostname: "page7.runtimed.run",
      service: "nteract-page7",
      bucket: shared.bucket,
      prefix: "standalone/page7",
      region: shared.region,
      listen: "127.0.0.1:9477",
      internalListen: "127.0.0.1:19477",
      runtime: shared.runtime,
      requiredVersion: shared.requiredVersion,
    }),
    sharing: true,
    oauth: true,
    firewallTable: "nteract_page7",
    firewallMark: "0x01000000",
    firewallComment: "nteract/preview-infra standalone-page7",
    asyncPersistence: true,
    compactRecords: true,
    companyViewDomains: "anaconda.com",
    editor: "wordgard",
    tunnelService: "cloudflared-page7.service",
    frozenTargets: Object.freeze(["pages-next", "page3", "page4", "page5", "page6"]),
  }),
  page8: Object.freeze({
    recordStorageMigration: DISABLED_MIGRATION,
    deployment: Object.freeze({
      host: shared.host,
      hostname: "page8.runtimed.run",
      service: "nteract-page8",
      bucket: shared.bucket,
      prefix: "standalone/page8",
      region: shared.region,
      listen: "127.0.0.1:9478",
      internalListen: "127.0.0.1:19478",
      runtime: shared.runtime,
      requiredVersion: shared.requiredVersion,
    }),
    sharing: true,
    oauth: true,
    theme: true,
    firewallTable: "nteract_page8",
    firewallMark: "0x00800000",
    firewallComment: "nteract/preview-infra standalone-page8",
    asyncPersistence: true,
    compactRecords: true,
    companyViewDomains: "anaconda.com",
    catalogIndex: "1",
    // The Cloudflare edge forwards an unsampled traceparent, and celld's
    // default parent-based sampler then drops every request-scoped log line.
    otelTracesSampler: "always_on",
    editor: "wordgard",
    tunnelService: "cloudflared-page8.service",
    frozenTargets: Object.freeze(["pages-next", "page3", "page4", "page5", "page6", "page7"]),
  }),
  page9: Object.freeze({
    recordStorageMigration: DISABLED_MIGRATION,
    deployment: Object.freeze({
      host: shared.host,
      hostname: "page9.runtimed.run",
      service: "nteract-page9",
      bucket: shared.bucket,
      prefix: "standalone/page9",
      region: shared.region,
      listen: "127.0.0.1:9479",
      internalListen: "127.0.0.1:19479",
      runtime: shared.runtime,
      requiredVersion: shared.requiredVersion,
    }),
    sharing: true,
    oauth: true,
    theme: true,
    // The viewer loads its editor from content-hashed /chunks/*.js files.
    viewerChunks: true,
    // The shell's own files (app.js, app.css, theme.js, mermaid.js and both
    // WASM runtimes) ship under content-hashed names too.
    viewerAssets: true,
    // A Project opens at /project/<id>; older /s/<id> links open it too.
    projectLinks: true,
    // The viewer's index routes: /projects and /pages.
    indexRoutes: true,
    firewallTable: "nteract_page9",
    firewallMark: "0x00400000",
    firewallComment: "nteract/preview-infra standalone-page9",
    asyncPersistence: true,
    compactRecords: true,
    companyViewDomains: "anaconda.com",
    catalogIndex: "1",
    // The Cloudflare edge forwards an unsampled traceparent, and celld's
    // default parent-based sampler then drops every request-scoped log line.
    otelTracesSampler: "always_on",
    editor: "wordgard",
    tunnelService: "cloudflared-page9.service",
    frozenTargets: Object.freeze(["page7", "page8"]),
  }),
  // A fresh, empty target with no data or route compatibility with Page9.
  page10: Object.freeze({
    recordStorageMigration: DISABLED_MIGRATION,
    deployment: Object.freeze({
      host: shared.host,
      hostname: "page10.runtimed.run",
      service: "nteract-page10",
      bucket: shared.bucket,
      prefix: "standalone/page10",
      region: shared.region,
      listen: "127.0.0.1:9480",
      internalListen: "127.0.0.1:19480",
      runtime: shared.runtime,
      requiredVersion: shared.requiredVersion,
    }),
    sharing: true,
    oauth: true,
    theme: true,
    // The viewer loads its editor from content-hashed /chunks/*.js files.
    viewerChunks: true,
    // The shell's own files (app.js, app.css, theme.js, mermaid.js and both
    // WASM runtimes) ship under content-hashed names too.
    viewerAssets: true,
    // A Project opens at /project/<id>; older /s/<id> links open it too.
    projectLinks: true,
    // The viewer's index routes: /projects and /pages.
    indexRoutes: true,
    // Sift's hashed WASM, for Parquet dataframe nodes.
    siftTables: true,
    whoami: true,
    firewallTable: "nteract_page10",
    firewallMark: "0x00200000",
    firewallComment: "nteract/preview-infra standalone-page10",
    asyncPersistence: true,
    compactRecords: true,
    companyViewDomains: "anaconda.com",
    catalogIndex: "1",
    // New Pages sync with plain Automerge sync instead of Subduction
    // (README: Plain Automerge sync). Existing Pages keep their mode.
    recordStorage: "automerge",
    // Each account's Page limit when no quota rule matches it
    // (worker/page-quota.mjs). It also bounds that account's Trash.
    pageQuota: "250",
    // The D1 database holding pages_quota_rules, for scripts/quota-rules.mjs.
    d1: AUTH_D1,
    // The Cloudflare edge forwards an unsampled traceparent, and celld's
    // default parent-based sampler then drops every request-scoped log line.
    otelTracesSampler: "always_on",
    editor: "wordgard",
    // tunnelService is the single connector unit earlier releases installed.
    // Publication hands the tunnel to these two slots and alternates between
    // them, so a route change never stops the last connector
    // (connector-slots.mjs). Metrics listeners serve cloudflared's /ready.
    tunnelService: "cloudflared-page10.service",
    tunnelSlots: Object.freeze({
      a: Object.freeze({ service: "cloudflared-page10-a.service", metrics: "127.0.0.1:29480" }),
      b: Object.freeze({ service: "cloudflared-page10-b.service", metrics: "127.0.0.1:29490" }),
    }),
    frozenTargets: Object.freeze(["page7", "page8", "page9"]),
  }),
  // pages.runtimed.run: the lasting home for Pages. It starts empty, with
  // Page10's flags and runtime; scripts/project-transfer.mjs copies Projects in.
  // Its service and prefix carry `-live` because the host still holds a
  // disabled nteract-pages.service and /etc/nteract-pages from an earlier
  // prototype, and the installer must never treat those as this target's.
  pages: Object.freeze({
    recordStorageMigration: DISABLED_MIGRATION,
    deployment: Object.freeze({
      host: shared.host,
      hostname: "pages.runtimed.run",
      service: "nteract-pages-live",
      bucket: shared.bucket,
      prefix: "standalone/pages-live",
      region: shared.region,
      listen: "127.0.0.1:9481",
      internalListen: "127.0.0.1:19481",
      runtime: shared.runtime,
      requiredVersion: shared.requiredVersion,
    }),
    sharing: true,
    oauth: true,
    theme: true,
    // The viewer loads its editor from content-hashed /chunks/*.js files.
    viewerChunks: true,
    // The shell's own files (app.js, app.css, theme.js, mermaid.js and both
    // WASM runtimes) ship under content-hashed names too.
    viewerAssets: true,
    // A Project opens at /project/<id>; older /s/<id> links open it too.
    projectLinks: true,
    // The viewer's index routes: /projects and /pages.
    indexRoutes: true,
    // Sift's hashed WASM, for Parquet dataframe nodes.
    siftTables: true,
    whoami: true,
    firewallTable: "nteract_pages_live",
    firewallMark: "0x00100000",
    firewallComment: "nteract/preview-infra standalone-pages-live",
    asyncPersistence: true,
    compactRecords: true,
    companyViewDomains: "anaconda.com",
    catalogIndex: "1",
    // New Pages sync with plain Automerge sync instead of Subduction
    // (README: Plain Automerge sync). Pages created before this keep
    // Subduction until a migration canary converts them (DEPLOYMENT.md:
    // Moving pages off Subduction).
    recordStorage: "automerge",
    // Each account's Page limit when no quota rule matches it
    // (worker/page-quota.mjs). It also bounds that account's Trash.
    pageQuota: "250",
    // The D1 database holding pages_quota_rules, for scripts/quota-rules.mjs.
    d1: AUTH_D1,
    // The Cloudflare edge forwards an unsampled traceparent, and celld's
    // default parent-based sampler then drops every request-scoped log line.
    otelTracesSampler: "always_on",
    editor: "wordgard",
    // The single connector unit earlier releases installed, then the two
    // slots publication alternates between (see Page10).
    tunnelService: "cloudflared-pages-live.service",
    tunnelSlots: Object.freeze({
      a: Object.freeze({ service: "cloudflared-pages-live-a.service", metrics: "127.0.0.1:29481" }),
      b: Object.freeze({ service: "cloudflared-pages-live-b.service", metrics: "127.0.0.1:29491" }),
    }),
    // Page10 stays deployable, so it is not frozen here.
    frozenTargets: Object.freeze(["page7", "page8", "page9"]),
  }),
});
export function deploymentProfile(target = "pages-next") {
  if (!Object.hasOwn(targets, target)) throw new Error("Unknown Pages deployment target");
  return targets[target];
}

/** The operator's migration canary on the host, beside the session secret:
 * `/etc/<service>/record-storage-migration.json`, root-owned in the 0700
 * config directory the installer creates. It holds the same
 * `{enabled, pageIds}` shape as a profile's `recordStorageMigration`. */
export const MIGRATION_POLICY_FILE = "record-storage-migration.json";
export function migrationPolicyPath(profile) {
  return "/etc/" + profile.deployment.service + "/" + MIGRATION_POLICY_FILE;
}
/** At most this many Page IDs in one canary, from either source. Widening
 * past it is a reason to review the rollout, not to raise the cap. */
export const MAX_MIGRATION_PAGE_IDS = 500;
/** The operator file's byte limit: 500 quoted UUIDs need about 20 KiB. */
export const MAX_MIGRATION_POLICY_BYTES = 64 * 1024;
const PAGE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const disabledPolicy = (policy) =>
  policy !== null &&
  typeof policy === "object" &&
  policy.enabled === false &&
  Array.isArray(policy.pageIds) &&
  policy.pageIds.length === 0;

function validMigrationPolicy(policy, profile) {
  return (
    policy &&
    typeof policy === "object" &&
    !Array.isArray(policy) &&
    !Object.keys(policy).some((key) => !["enabled", "pageIds"].includes(key)) &&
    typeof policy.enabled === "boolean" &&
    Array.isArray(policy.pageIds) &&
    policy.pageIds.length <= MAX_MIGRATION_PAGE_IDS &&
    Array.from(policy.pageIds).every((id) => typeof id === "string" && PAGE_UUID.test(id)) &&
    new Set(policy.pageIds).size === policy.pageIds.length &&
    !(policy.enabled && (!policy.pageIds.length || profile.recordStorage !== "automerge"))
  );
}

/** Parse and check the operator file's text. Stricter than a profile policy:
 * the file only makes sense where new Pages are already plain, so any file,
 * even a disabled one, requires `recordStorage: "automerge"`. */
export function operatorMigrationPolicy(profile, text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > MAX_MIGRATION_POLICY_BYTES)
    throw new Error(
      `Invalid record storage migration canary file: over ${MAX_MIGRATION_POLICY_BYTES} bytes`,
    );
  let policy;
  try {
    policy = JSON.parse(text);
  } catch {
    throw new Error("Invalid record storage migration canary file: not JSON");
  }
  if (profile.recordStorage !== "automerge")
    throw new Error(
      "Invalid record storage migration canary file: the profile does not set recordStorage automerge",
    );
  if (!validMigrationPolicy(policy, profile))
    throw new Error(
      "Invalid record storage migration canary file: expected {enabled, pageIds} with at most " +
        `${MAX_MIGRATION_PAGE_IDS} unique lowercase Page UUIDs; there is no wildcard`,
    );
  return policy;
}

/** Serialize reviewed profile policy, or the operator file on the host
 * (`operatorText`, its contents, or undefined when there is none). Never the
 * installer's environment. The file may only stand in for a disabled, empty
 * profile policy: two sources for one list is refused, not merged.
 * This module is staged alone; keep validation independent of Worker imports. */
export function migrationVars(profile, operatorText) {
  const reviewed =
    profile.recordStorageMigration === undefined
      ? DISABLED_MIGRATION
      : profile.recordStorageMigration;
  if (!validMigrationPolicy(reviewed, profile))
    throw new Error("Invalid record storage migration canary policy");
  let policy = reviewed;
  if (operatorText !== undefined) {
    if (!disabledPolicy(reviewed))
      throw new Error(
        "Invalid record storage migration canary policy: both the profile and the operator file set one",
      );
    policy = operatorMigrationPolicy(profile, operatorText);
  }
  // Preserve app-only adoption for targets that have never enabled migration.
  if (!policy.enabled && !policy.pageIds.length) return {};
  return {
    PAGES_MIGRATE_RECORD_STORAGE: String(policy.enabled),
    PAGES_MIGRATE_PAGE_IDS: JSON.stringify(policy.pageIds),
  };
}
// This release is qualified for the isolated Page10 and Pages targets. Page10
// stays deployable until its Projects are copied to Pages.
// Historical profiles remain readable for comparison and frozen-release checks.
export const QUALIFIED_TARGETS = Object.freeze(["page10", "pages"]);
export function assertQualifiedDeploymentTarget(target) {
  deploymentProfile(target);
  if (!QUALIFIED_TARGETS.includes(target))
    throw new Error(
      "This build is qualified only for page10 and pages; earlier deployments are frozen",
    );
}

// Record storage modes beyond the native ones (`local`, `buffered`) that each
// target has been configured to create Pages with. A Page keeps its mode for
// life, so an entry stays after the profile stops setting `recordStorage`: the
// target still holds those Pages. Remove one only once the target's data holds
// no Page with that mode. page10 has created `automerge` Pages since a2c9d5dde.
// pages creates `automerge` Pages once a release configured from its profile
// runs there. Its entry holds whether or not that install has happened, so no
// checkout that knows the profile can install a build without plain sync.
export const RECORD_STORAGE_HISTORY = Object.freeze({
  page10: Object.freeze(["automerge"]),
  pages: Object.freeze(["automerge"]),
});
const NATIVE_RECORD_STORAGE = Object.freeze(["local", "buffered"]);

/** The record storage modes beyond the native ones that `target` may hold
 * Pages in: its history, its profile, and any `observed` on the host (the
 * PAGES_RECORD_STORAGE of releases installed there). Each maps to why. */
export function targetRecordStorage(target, observed = []) {
  const profile = deploymentProfile(target);
  const reasons = new Map();
  const note = (mode, reason) => {
    if (typeof mode !== "string" || !mode || NATIVE_RECORD_STORAGE.includes(mode)) return;
    reasons.set(mode, [...(reasons.get(mode) ?? []), reason]);
  };
  for (const mode of RECORD_STORAGE_HISTORY[target] ?? [])
    note(mode, "RECORD_STORAGE_HISTORY lists it");
  note(profile.recordStorage, "its profile sets recordStorage");
  for (const { mode, release } of observed)
    note(mode, `release ${release} on the host was configured with it`);
  return reasons;
}

/** Refuse a release whose build cannot open every Page `target` may hold.
 * `receipt` is the release's build receipt (manifest `build_receipt`, or
 * dist/build-receipt.json); its `record_storage` lists the modes the Worker
 * opens. A receipt without the list predates it and opens none beyond the
 * native modes, so it counts as lacking every other mode. */
export function assertReleaseOpensTargetPages(target, receipt, observed = []) {
  const declared = Array.isArray(receipt?.record_storage) ? receipt.record_storage : [];
  const required = targetRecordStorage(target, observed);
  const missing = [...required].filter(([mode]) => !declared.includes(mode));
  const release =
    `${typeof receipt?.source_sha === "string" ? receipt.source_sha.slice(0, 12) : "unknown source"}` +
    ` (build ${receipt?.build_id ?? "unknown"})`;
  if (missing.length)
    throw new Error(
      `Refusing release ${release} for ${target}: ` +
        missing
          .map(([mode, reasons]) => `${target} may hold "${mode}" Pages (${reasons.join("; ")})`)
          .join(", ") +
        `, and the release's build receipt lists record_storage ` +
        `${declared.length ? JSON.stringify(declared) : "none"}. A build without a Page's ` +
        `record storage fails to open it with "Unsupported Page record storage mode".`,
    );
  // Keep the deploy-time requirement here: the staged installer copies this
  // module without the Worker's shared modules. All operator entrypoints use
  // this guard, including old-stage install and rollback qualification.
  const format = "doc-store-v2-host-actor-prefix";
  const formats = Array.isArray(receipt?.plain_storage_formats)
    ? receipt.plain_storage_formats
    : [];
  if (required.has("automerge") && !formats.includes(format))
    throw new Error(
      `Refusing release ${release} for ${target}: ${target} may hold "automerge" Pages ` +
        `(${required.get("automerge").join("; ")}), requiring plain_storage_formats ${JSON.stringify([format])}; ` +
        `the release lists ${JSON.stringify(formats)}. Older builds can lose plain history or bypass host actor admission.`,
    );
}

export function selectTarget(argv) {
  const args = [...argv];
  const target = args[0] === "--target" ? (args.splice(0, 2)[1] ?? "") : "pages-next";
  deploymentProfile(target);
  return { target, args };
}
export function stagePattern(target = "pages-next") {
  const { deployment } = deploymentProfile(target);
  return new RegExp("^/tmp/" + deployment.service + "-stage-[A-Za-z0-9]{8}$");
}
export function stageTarget(stage) {
  const target = Object.keys(targets).find((name) => stagePattern(name).test(stage ?? ""));
  if (!target) throw new Error("Explicit prepared stage for a known Pages target required");
  return target;
}
export function verifyDeployment(manifest, target = "pages-next") {
  const { deployment } = deploymentProfile(target);
  if (
    JSON.stringify(manifest.deployment) !== JSON.stringify(deployment) ||
    !/^[a-f0-9]{40}$/.test(manifest.source_sha ?? "")
  )
    throw new Error("Unexpected deployment target or source");
  return deployment;
}
