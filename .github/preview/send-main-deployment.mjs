#!/usr/bin/env node
import {appendFile} from "node:fs/promises";
import {pathToFileURL} from "node:url";
import {controllerClient} from "./client.mjs";
import {resolveMainRequest} from "./main-github.mjs";
import {check} from "./protocol.mjs";

export async function deployMain(env, {fetcher = fetch, event, client} = {}) {
  const request = await resolveMainRequest(env, fetcher, event);
  client ??= controllerClient(env, fetcher);
  await client.authorize(request);
  // Admission does not reserve a revision. Refresh the source/build evidence
  // immediately before asking the controller to mutate the fixed deployment.
  const current = await resolveMainRequest(env, fetcher, event);
  const operation = await client.deploy(current);
  check(operation.result?.id === "main" && operation.result?.status === "ready" &&
    operation.result?.sha === current.sourceSha, "Controller did not confirm the requested main revision");
  return current.sourceSha;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const sha = await deployMain(process.env);
    const message = `Deployed main at ${sha}. [Open main](https://main.runtimed.run)`;
    console.log(message);
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${message}\n`);
  } catch {
    // Never print upstream bodies, request credentials, or artifact contents.
    console.error("Main deployment did not complete. Inspect the build, current main revision, and controller diagnostics.");
    process.exitCode = 1;
  }
}
