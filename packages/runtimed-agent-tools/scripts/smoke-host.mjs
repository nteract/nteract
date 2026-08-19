import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const host = process.argv[2];
if (host !== "opencode" && host !== "kilo") {
  throw new Error("usage: node scripts/smoke-host.mjs <opencode|kilo>");
}

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtureDirectory = join(packageRoot, "fixtures", host);
const configHome = await mkdtemp(join(tmpdir(), `runtimed-agent-tools-${host}-`));
const port = await availablePort();
const output = [];

const child = spawn(host, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
  cwd: fixtureDirectory,
  env: { ...process.env, XDG_CONFIG_HOME: configHome },
  stdio: ["ignore", "pipe", "pipe"],
});

child.stdout.on("data", (chunk) => output.push(String(chunk)));
child.stderr.on("data", (chunk) => output.push(String(chunk)));

try {
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForServer(`${baseUrl}/config`, child, output);
  const url = new URL(`${baseUrl}/experimental/tool/ids`);
  url.searchParams.set("directory", fixtureDirectory);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${host} tool listing failed with HTTP ${response.status}`);
  }
  const toolIds = await response.json();
  if (!Array.isArray(toolIds) || !toolIds.includes("notebook_run_source")) {
    throw new Error(`${host} did not register notebook_run_source: ${JSON.stringify(toolIds)}`);
  }
  console.log(`${host} registered notebook_run_source`);
} finally {
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
  await rm(configHome, { recursive: true, force: true });
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("could not reserve a smoke-test port");
  }
  const { port } = address;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function waitForServer(url, child, logs) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`${host} exited before startup:\n${logs.join("")}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The host has not bound the socket yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${host} did not start within 20 seconds:\n${logs.join("")}`);
}
