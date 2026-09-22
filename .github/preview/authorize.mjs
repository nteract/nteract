#!/usr/bin/env node
import {appendFile} from "node:fs/promises";
import {resolveRequest} from "./github.mjs";
import {controllerClient} from "./client.mjs";

try {
  const request = await resolveRequest(process.env);
  await controllerClient(process.env).authorize(request);
  const values = {pr: request.pr, sha: request.sourceSha, preview_id: request.previewId, action: request.action};
  await appendFile(process.env.GITHUB_OUTPUT, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(""));
  console.log(`Authorized ${request.action} for ${request.previewId} at ${request.sourceSha}`);
} catch (error) {
  // Never echo upstream response bodies or request credentials.
  console.error(error.message);
  process.exitCode = 1;
}
