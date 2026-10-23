// Allowlisted isolated lab targets. Never accept arbitrary host, port or storage overrides.
const shared = {
  host: "lab1",
  bucket: "nteract-celld-lab-621741996708",
  region: "us-east-1",
  runtime: "/usr/local/bin/celld-v0.6.1",
  requiredVersion: "celld 0.6.1",
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
