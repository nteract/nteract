#!/usr/bin/env node
import {appendFile} from "node:fs/promises";
import {resolveRequest} from "./github.mjs";
import {controllerClient} from "./client.mjs";
import {artifactFields} from "./protocol.mjs";

try {
  // Resolve again on this fresh runner: authorization can change during a build.
  const request = await resolveRequest(process.env);
  if (request.action === "deploy") Object.assign(request, artifactFields(process.env));
  await controllerClient(process.env).deploy(request);
  const message = `${request.action === "deploy" ? "Deployed" : "Stopped"} ${request.previewId} at ${request.sourceSha}`;
  console.log(message);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const link = request.action === "deploy" ? `\n\n[Open preview](https://${request.previewId}.runtimed.run)` : "";
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `${message}${link}\n`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
