import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const publish = await runNode(["--import", "tsx", "scripts/publish-live.mjs"], process.env);
const publishResult = parseJson(publish.stdout, "publish-live");
if (!publishResult.viewerUrl) {
  throw new Error("publish-live output did not include viewerUrl");
}

const smokeEnv = {
  ...process.env,
  NOTEBOOK_CLOUD_HOSTED_URL: publishResult.viewerUrl,
};
if (!smokeEnv.NOTEBOOK_CLOUD_EXPECTED_RENDERER_ASSET_ORIGIN) {
  const origin = new URL(publishResult.viewerUrl).origin;
  if (isLoopbackOrigin(origin)) {
    smokeEnv.NOTEBOOK_CLOUD_EXPECTED_RENDERER_ASSET_ORIGIN = origin;
  }
}

const smoke = await runNode(["scripts/hosted-render-smoke.mjs", publishResult.viewerUrl], smokeEnv);
const smokeResult = parseJson(smoke.stdout, "hosted-render-smoke");

console.log(
  JSON.stringify(
    {
      ok: true,
      publish: publishResult,
      smoke: smokeResult,
    },
    null,
    2,
  ),
);

function runNode(args, env) {
  console.error(`$ node ${args.join(" ")}`);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: appDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(
        new Error(
          `node ${args.join(" ")} exited with ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
        ),
      );
    });
  });
}

function parseJson(stdout, label) {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`${label} did not print JSON: ${error.message}\n${stdout}`);
  }
}

function isLoopbackOrigin(origin) {
  const hostname = new URL(origin).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}
