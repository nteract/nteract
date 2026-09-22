#!/usr/bin/env node
import {appendFile} from "node:fs/promises";
import {controllerClient} from "./client.mjs";
import {resolveStatusRequest} from "./status.mjs";

try {
  const request = await resolveStatusRequest(process.env);
  const result = await controllerClient(process.env).status(request);
  const message = result.updated ? `Updated preview comment for ${request.previewId}` :
    `Preview comment unchanged for ${request.previewId}`;
  console.log(message);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${message}\n`);
} catch {
  // Status is controller-derived. Never publish arbitrary upstream responses,
  // log text, or credentials as a comment or workflow message.
  console.error("Preview comment could not be updated; inspect the trusted status job and controller diagnostics");
  process.exitCode = 1;
}
