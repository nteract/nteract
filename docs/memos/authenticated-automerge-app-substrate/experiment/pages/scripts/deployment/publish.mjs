// Narrow tunnel change only. DNS is a separate operation after route validation.
// Every target owns its tunnel and connector, so publication always runs
// isolated-publication.mjs and never edits a shared cloudflared configuration.
import { pathToFileURL } from "node:url";
import { assertQualifiedDeploymentTarget, stageTarget } from "./profiles.mjs";
import { publishIsolated } from "./isolated-publication.mjs";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [stage, apply, extra] = process.argv.slice(2);
  const target = stageTarget(stage);
  assertQualifiedDeploymentTarget(target);
  if (process.getuid() !== 0 || apply !== "--apply" || extra)
    throw new Error("Explicit root publication with prepared stage required");
  console.log(JSON.stringify(publishIsolated(stage)));
}
