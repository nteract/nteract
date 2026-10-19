import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import {access, appendFile, mkdir, mkdtemp, readFile, rename, rm, writeFile} from "node:fs/promises";
import {dirname, join, resolve} from "node:path";
import {setTimeout as sleep} from "node:timers/promises";
import {fileURLToPath} from "node:url";

// Pin the archive published by Tauri; that release is the artifact trust root:
// https://github.com/tauri-apps/binary-releases/releases/tag/nsis-3.13
// Its release notes cite this NSIS upstream file (not independently compared):
// https://sourceforge.net/projects/nsis/files/NSIS%203/3.13/nsis-3.13.zip/download
// SHA-256: the release asset's digest from the GitHub releases API, independently
// checked against the downloaded bytes. Keep the version, URL and digest together.
export const NSIS = Object.freeze({
  version: "3.13",
  url: "https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.13/nsis-3.13.zip",
  sha256: "ba63dffc4410ee89193e1cb5a41989991bd77c61068da17e3156d136b7b0b3d8",
});

function verifyArchive(bytes, sha256) {
  if (createHash("sha256").update(bytes).digest("hex") !== sha256) {
    throw new Error("NSIS archive SHA-256 mismatch; refusing to extract or execute it");
  }
}

function transientDownloadError(error) {
  return [408, 429, 500, 502, 503, 504].includes(error.status) ||
    error.name === "TimeoutError" ||
    ["EAI_AGAIN", "ECONNRESET", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_SOCKET"]
      .includes(error.cause?.code ?? error.code);
}

export async function verifiedArchive(archivePath, {
  artifact = NSIS, fetchImpl = fetch, sleepImpl = sleep,
} = {}) {
  let cached;
  try {
    cached = await readFile(archivePath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (cached) {
    verifyArchive(cached, artifact.sha256);
    return archivePath;
  }

  let bytes;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetchImpl(artifact.url, {signal: AbortSignal.timeout(60_000)});
      if (!response.ok) {
        await response.body?.cancel();
        throw Object.assign(new Error(`NSIS download returned HTTP ${response.status}`), {status: response.status});
      }
      bytes = Buffer.from(await response.arrayBuffer());
      break;
    } catch (error) {
      if (attempt === 3 || !transientDownloadError(error)) throw error;
      console.warn(`Transient NSIS download failure (${attempt}/3): ${error.message}`);
      await sleepImpl(attempt * 1000);
    }
  }
  // Integrity failures are permanent, not retried as network failures.
  verifyArchive(bytes, artifact.sha256);
  await mkdir(dirname(archivePath), {recursive: true});
  const partial = `${archivePath}.partial`;
  await writeFile(partial, bytes);
  await rename(partial, archivePath);
  return archivePath;
}

export async function installNsis({
  cacheDir, toolsDir, githubPath, platform = process.platform,
  artifact = NSIS, fetchImpl = fetch, sleepImpl = sleep, execute = execFileSync,
}) {
  if (platform !== "win32") throw new Error("NSIS setup is only for disposable Windows CI runners");
  if (!cacheDir || !toolsDir || !githubPath) throw new Error("NSIS setup requires runner-local paths and GITHUB_PATH");
  const archive = await verifiedArchive(join(cacheDir, `nsis-${artifact.version}.zip`), {artifact, fetchImpl, sleepImpl});
  await mkdir(toolsDir, {recursive: true});
  const staging = await mkdtemp(join(toolsDir, "nsis-"));
  try {
    execute("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      "$ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath $env:NTERACT_NSIS_ARCHIVE -DestinationPath $env:NTERACT_NSIS_DESTINATION"], {
      env: {...process.env, NTERACT_NSIS_ARCHIVE: archive, NTERACT_NSIS_DESTINATION: staging},
      stdio: "pipe", timeout: 120_000,
    });
    const executable = join(staging, `nsis-${artifact.version}`, "makensis.exe");
    await access(executable);
    const version = execute(executable, ["/VERSION"], {encoding: "utf8", timeout: 30_000}).trim();
    if (version !== `v${artifact.version}`) throw new Error(`Unexpected makensis version: ${version}`);
    // Publish only a verified, runnable compiler. GitHub prepends this directory
    // to PATH for the following compilation and registry-preservation steps.
    await appendFile(githubPath, `${dirname(executable)}\n`);
    console.log(`Verified NSIS ${version}: ${executable}`);
    return executable;
  } catch (error) {
    await rm(staging, {recursive: true, force: true});
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (!process.env.RUNNER_TEMP) throw new Error("RUNNER_TEMP is required");
    await installNsis({
      cacheDir: join(process.env.RUNNER_TEMP, "nsis-download"),
      toolsDir: join(process.env.RUNNER_TEMP, "nsis-tools"),
      githubPath: process.env.GITHUB_PATH,
    });
  } catch (error) {
    console.error(`NSIS setup failed: ${error.message}`);
    process.exitCode = 1;
  }
}
