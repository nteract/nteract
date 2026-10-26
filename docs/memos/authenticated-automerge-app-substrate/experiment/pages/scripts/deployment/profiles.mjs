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

const shared = {
  host: "lab1",
  bucket: "nteract-celld-lab-621741996708",
  region: "us-east-1",
  runtime: CELLD_RELEASE.path,
  requiredVersion: CELLD_RELEASE.version,
};
const targets = Object.freeze({
  "pages-next": Object.freeze({
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
    firewallTable: "nteract_page5",
    firewallMark: "0x04000000",
    firewallComment: "nteract/preview-infra standalone-page5",
    asyncPersistence: true,
    editor: "wordgard",
    tunnelService: "cloudflared-page5.service",
    frozenTargets: Object.freeze(["pages-next", "page3", "page4"]),
  }),
  page6: Object.freeze({
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
    firewallTable: "nteract_page6",
    firewallMark: "0x02000000",
    firewallComment: "nteract/preview-infra standalone-page6",
    asyncPersistence: true,
    editor: "wordgard",
    tunnelService: "cloudflared-page6.service",
    frozenTargets: Object.freeze(["pages-next", "page3", "page4", "page5"]),
  }),
  page7: Object.freeze({
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
    firewallTable: "nteract_page7",
    firewallMark: "0x01000000",
    firewallComment: "nteract/preview-infra standalone-page7",
    asyncPersistence: true,
    editor: "wordgard",
    tunnelService: "cloudflared-page7.service",
    frozenTargets: Object.freeze(["pages-next", "page3", "page4", "page5", "page6"]),
  }),
});
export function deploymentProfile(target = "pages-next") {
  if (!Object.hasOwn(targets, target)) throw new Error("Unknown Pages deployment target");
  return targets[target];
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
