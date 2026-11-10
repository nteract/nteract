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

const shared = {
  host: "lab1",
  bucket: "nteract-celld-lab-621741996708",
  region: "us-east-1",
  runtime: CELLD_RELEASE.path,
  requiredVersion: CELLD_RELEASE.version,
};
// Unit limits for targets without a memory field, matching what they shipped with.
export const DEFAULT_MEMORY = Object.freeze({ maxRssMb: 768, memoryMax: "1G" });
const SERVING_MEMORY = Object.freeze({ maxRssMb: 2560, memoryMax: "4G" });
/**
 * The celld shedding threshold and systemd ceiling for a profile's unit.
 * MemoryMax must leave headroom above the shedding threshold, or systemd kills
 * celld before it sheds.
 */
export function unitMemory(profile) {
  const { maxRssMb, memoryMax } = profile.memory ?? DEFAULT_MEMORY;
  if (!Number.isSafeInteger(maxRssMb) || maxRssMb < 256 || maxRssMb > 16384)
    throw new Error("memory.maxRssMb must be an integer from 256 to 16384");
  const match = /^([1-9][0-9]?)G$/.exec(memoryMax ?? "");
  if (!match) throw new Error("memory.memoryMax must be whole gigabytes, such as 4G");
  if (Number(match[1]) * 1024 < maxRssMb * 1.25)
    throw new Error("memory.memoryMax must be at least 25% above memory.maxRssMb");
  return { maxRssMb, memoryMax };
}
const targets = Object.freeze({
  // Pages held here before pages.runtimed.run; it stays deployable until its
  // Projects are copied there.
  page10: Object.freeze({
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
    // /api/auth/logout-all and /api/auth/grants[/<handle>/revoke]: sign out
    // everywhere and connected agents (worker/account-auth.mjs).
    accountRoutes: true,
    // /p/<id>/meta.json and /card.json, and the same under /project/<id>:
    // what a link shows its reader (worker/link-previews.mjs).
    linkPreviews: true,
    // /api/pages/<id>/card-image[/<hash>-<theme>.<ext>]: grid card images
    // (worker/card-images.mjs).
    cardImages: true,
    // /api/projects/<id>/assets[/<sha256>]: a Project's assets, which belong
    // to its content document.
    projectAssets: true,
    firewallTable: "nteract_page10",
    firewallMark: "0x00200000",
    firewallComment: "nteract/preview-infra standalone-page10",
    companyViewDomains: "anaconda.com",
    catalogIndex: "1",
    // Each account's Page limit when no quota rule matches it
    // (worker/page-quota.mjs). It also bounds that account's Trash.
    pageQuota: "250",
    // The D1 database holding pages_quota_rules, for scripts/quota-rules.mjs.
    d1: AUTH_D1,
    // The Cloudflare edge forwards an unsampled traceparent, and celld's
    // default parent-based sampler then drops every request-scoped log line.
    otelTracesSampler: "always_on",
    // celld sheds cells above CELLD_MAX_RSS_MB. At 768 MB production shed its
    // D1 cell repeatedly and signed-in requests failed while it restored.
    // lab1 has 31 GB; MemoryMax stays above the shedding threshold.
    memory: SERVING_MEMORY,
    // tunnelService is the single connector unit earlier releases installed.
    // Publication hands the tunnel to these two slots and alternates between
    // them, so a route change never stops the last connector
    // (connector-slots.mjs). Metrics listeners serve cloudflared's /ready.
    tunnelService: "cloudflared-page10.service",
    tunnelSlots: Object.freeze({
      a: Object.freeze({ service: "cloudflared-page10-a.service", metrics: "127.0.0.1:29480" }),
      b: Object.freeze({ service: "cloudflared-page10-b.service", metrics: "127.0.0.1:29490" }),
    }),
  }),
  // pages.runtimed.run: the lasting home for Pages. It starts empty, with
  // Page10's flags and runtime; scripts/project-transfer.mjs copies Projects in.
  // Its service and prefix carry `-live` because the host still holds a
  // disabled nteract-pages.service and /etc/nteract-pages from an earlier
  // prototype, and the installer must never treat those as this target's.
  pages: Object.freeze({
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
    // /api/auth/logout-all and /api/auth/grants[/<handle>/revoke]: sign out
    // everywhere and connected agents (worker/account-auth.mjs).
    accountRoutes: true,
    // /p/<id>/meta.json and /card.json, and the same under /project/<id>:
    // what a link shows its reader (worker/link-previews.mjs).
    linkPreviews: true,
    // /api/pages/<id>/card-image[/<hash>-<theme>.<ext>]: grid card images
    // (worker/card-images.mjs).
    cardImages: true,
    // /api/projects/<id>/assets[/<sha256>]: a Project's assets, which belong
    // to its content document.
    projectAssets: true,
    firewallTable: "nteract_pages_live",
    firewallMark: "0x00100000",
    firewallComment: "nteract/preview-infra standalone-pages-live",
    companyViewDomains: "anaconda.com",
    catalogIndex: "1",
    // Each account's Page limit when no quota rule matches it
    // (worker/page-quota.mjs). It also bounds that account's Trash.
    pageQuota: "250",
    // The D1 database holding pages_quota_rules, for scripts/quota-rules.mjs.
    d1: AUTH_D1,
    // The Cloudflare edge forwards an unsampled traceparent, and celld's
    // default parent-based sampler then drops every request-scoped log line.
    otelTracesSampler: "always_on",
    // Same limits as Page10; see its memory comment.
    memory: SERVING_MEMORY,
    // The single connector unit earlier releases installed, then the two
    // slots publication alternates between (see Page10).
    tunnelService: "cloudflared-pages-live.service",
    tunnelSlots: Object.freeze({
      a: Object.freeze({ service: "cloudflared-pages-live-a.service", metrics: "127.0.0.1:29481" }),
      b: Object.freeze({ service: "cloudflared-pages-live-b.service", metrics: "127.0.0.1:29491" }),
    }),
  }),
  // page2.runtimed.run (target pages2): a fresh, empty target on its own host, lab2 (m7i.large,
  // 8 GB). Pages' flags; it has only ever held plain Automerge Pages. Its listeners,
  // firewall table and mark, tunnel and prefix are distinct from every lab1
  // profile, so neither host can mistake the other's resources for its own.
  pages2: Object.freeze({
    deployment: Object.freeze({
      host: "lab2",
      hostname: "page2.runtimed.run",
      service: "nteract-pages2",
      bucket: shared.bucket,
      prefix: "standalone/pages2",
      region: shared.region,
      listen: "127.0.0.1:9482",
      internalListen: "127.0.0.1:19482",
      runtime: shared.runtime,
      requiredVersion: shared.requiredVersion,
    }),
    sharing: true,
    oauth: true,
    theme: true,
    viewerChunks: true,
    viewerAssets: true,
    projectLinks: true,
    indexRoutes: true,
    siftTables: true,
    whoami: true,
    // /api/auth/logout-all and /api/auth/grants[/<handle>/revoke]: sign out
    // everywhere and connected agents (worker/account-auth.mjs).
    accountRoutes: true,
    // /p/<id>/meta.json and /card.json, and the same under /project/<id>:
    // what a link shows its reader (worker/link-previews.mjs).
    linkPreviews: true,
    // /api/pages/<id>/card-image[/<hash>-<theme>.<ext>]: grid card images
    // (worker/card-images.mjs).
    cardImages: true,
    // /api/projects/<id>/assets[/<sha256>]: a Project's assets, which belong
    // to its content document.
    projectAssets: true,
    firewallTable: "nteract_pages2",
    firewallMark: "0x00080000",
    firewallComment: "nteract/preview-infra standalone-pages2",
    companyViewDomains: "anaconda.com",
    catalogIndex: "1",
    pageQuota: "250",
    // The same binding and database_id as Pages. celld keeps the database
    // under this target's prefix and creates it empty on first use, so
    // pages2 starts with its own auth, OIDC and quota tables.
    d1: AUTH_D1,
    otelTracesSampler: "always_on",
    // m7i.large has 8 GB. MemoryMax 4G leaves the host room for cloudflared.
    memory: SERVING_MEMORY,
    // lab2 runs no shared cloudflared connector (/etc/cloudflared/config.yml);
    // publication checks it only if one appears.
    sharedTunnel: false,
    tunnelService: "cloudflared-pages2.service",
    tunnelSlots: Object.freeze({
      a: Object.freeze({ service: "cloudflared-pages2-a.service", metrics: "127.0.0.1:29482" }),
      b: Object.freeze({ service: "cloudflared-pages2-b.service", metrics: "127.0.0.1:29492" }),
    }),
    // lab2 holds no other Pages target, so nothing is frozen beside it.
  }),
  // Separate rich-text experiment using the plain Automerge doc-store backend.
  // Its storage floor protects that backend, not pages2's rich-text model.
  page11: Object.freeze({
    deployment: Object.freeze({
      host: "lab2",
      hostname: "page11.runtimed.run",
      service: "nteract-page11",
      bucket: shared.bucket,
      prefix: "standalone/page11",
      region: shared.region,
      listen: "127.0.0.1:9483",
      internalListen: "127.0.0.1:19483",
      runtime: shared.runtime,
      requiredVersion: shared.requiredVersion,
    }),
    sharing: true,
    oauth: true,
    theme: true,
    viewerChunks: true,
    viewerAssets: true,
    projectLinks: true,
    indexRoutes: true,
    siftTables: true,
    whoami: true,
    accountRoutes: true,
    linkPreviews: true,
    cardImages: true,
    projectAssets: true,
    firewallTable: "nteract_page11",
    // Below Tailscale's reserved mark mask (0x00ff0000).
    firewallMark: "0x00008000",
    firewallComment: "nteract/preview-infra standalone-page11",
    companyViewDomains: "anaconda.com",
    catalogIndex: "1",
    pageQuota: "250",
    // celld scopes both D1 databases to this target's fleet prefix.
    d1: AUTH_D1,
    otelTracesSampler: "always_on",
    // lab2 also hosts pages2 with a 4G ceiling; leave room for the OS.
    memory: Object.freeze({ maxRssMb: 1280, memoryMax: "2G" }),
    sharedTunnel: false,
    tunnelService: "cloudflared-page11.service",
    tunnelSlots: Object.freeze({
      a: Object.freeze({ service: "cloudflared-page11-a.service", metrics: "127.0.0.1:29483" }),
      b: Object.freeze({ service: "cloudflared-page11-b.service", metrics: "127.0.0.1:29493" }),
    }),
    frozenTargets: Object.freeze(["pages2"]),
  }),
});
/** Every deployment profile name, qualified or not. */
export const DEPLOYMENT_TARGETS = Object.freeze(Object.keys(targets));
export function deploymentProfile(target) {
  if (!Object.hasOwn(targets, target)) throw new Error("Unknown Pages deployment target");
  return targets[target];
}

// Every profile is a live target. Installation and publication run only for
// these four; app qualification is separate and must precede installation.
// Page10 stays deployable until its Projects are copied to Pages.
export const QUALIFIED_TARGETS = Object.freeze(["page10", "pages", "pages2", "page11"]);
export function assertQualifiedDeploymentTarget(target) {
  deploymentProfile(target);
  if (!QUALIFIED_TARGETS.includes(target))
    throw new Error("This build deploys only page10, pages, pages2 and page11");
}

// The record storage each target may hold Pages in, beyond the native modes
// (`local`, `buffered`) of earlier builds. These targets use the plain Automerge
// doc-store backend, so a release there must open
// `automerge` Pages: assertReleaseOpensTargetPages refuses one that can't,
// including a rollback to a build from before plain sync.
export const RECORD_STORAGE_HISTORY = Object.freeze({
  page10: Object.freeze(["automerge"]),
  pages: Object.freeze(["automerge"]),
  pages2: Object.freeze(["automerge"]),
  page11: Object.freeze(["automerge"]),
});
const NATIVE_RECORD_STORAGE = Object.freeze(["local", "buffered"]);

/** The record storage modes beyond the native ones that `target` may hold
 * Pages in: its history, and any `observed` on the host (the
 * PAGES_RECORD_STORAGE of releases installed there). Each maps to why. */
export function targetRecordStorage(target, observed = []) {
  deploymentProfile(target);
  const reasons = new Map();
  const note = (mode, reason) => {
    if (typeof mode !== "string" || !mode || NATIVE_RECORD_STORAGE.includes(mode)) return;
    reasons.set(mode, [...(reasons.get(mode) ?? []), reason]);
  };
  for (const mode of RECORD_STORAGE_HISTORY[target] ?? [])
    note(mode, "RECORD_STORAGE_HISTORY lists it");
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
  if (args[0] !== "--target") throw new Error("Name the Pages deployment target with --target");
  const target = args.splice(0, 2)[1] ?? "";
  deploymentProfile(target);
  return { target, args };
}
export function stagePattern(target) {
  const { deployment } = deploymentProfile(target);
  return new RegExp("^/tmp/" + deployment.service + "-stage-[A-Za-z0-9]{8}$");
}
export function stageTarget(stage) {
  const target = Object.keys(targets).find((name) => stagePattern(name).test(stage ?? ""));
  if (!target) throw new Error("Explicit prepared stage for a known Pages target required");
  return target;
}
export function verifyDeployment(manifest, target) {
  const { deployment } = deploymentProfile(target);
  if (
    JSON.stringify(manifest.deployment) !== JSON.stringify(deployment) ||
    !/^[a-f0-9]{40}$/.test(manifest.source_sha ?? "")
  )
    throw new Error("Unexpected deployment target or source");
  return deployment;
}
