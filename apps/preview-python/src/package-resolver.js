import { PACKAGE_ACQUISITION_MS } from "./package-limits.js";

const MAX_WHEEL_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 24 * 1024 * 1024;
const MAX_METADATA_BYTES = 8 * 1024 * 1024;
const MAX_STEPS = 64;
const MAX_WHEELS = 32;
const MAX_REQUIREMENTS = 64;

const PACKAGE_ERRORS = Object.freeze({
  invalid_requirement:
    "Use a PyPI package name with optional version constraints or extras. Wheel URLs and local paths are unsupported.",
  planner_busy: "Another package installation is being prepared. Try again shortly.",
  add_cooldown: "Wait a few seconds before starting another package installation.",
  planner_unavailable:
    "The package service needs recovery before it can prepare another installation. Try again later.",
  incompatible:
    "A requested version conflicts with an included package. The included scientific package versions are fixed.",
  unavailable:
    "No compatible package set was found. Check the names and versions; only pure Python wheels and included scientific packages are supported.",
  resolution_limit: "Package resolution limit exceeded. Try fewer requirements at a time.",
});

export class PackageOperationError extends Error {
  constructor(code) {
    super(PACKAGE_ERRORS[code]);
    this.code = code;
  }
}

export function safePackageFailure(error) {
  const code =
    error instanceof PackageOperationError && Object.hasOwn(PACKAGE_ERRORS, error.code)
      ? error.code
      : "acquisition_failed";
  return {
    status: "error",
    code,
    needs_restart: false,
    error:
      PACKAGE_ERRORS[code] ??
      "Packages could not be resolved or downloaded. Check compatibility and try again.",
  };
}

export function validateRequirements(value) {
  if (!Array.isArray(value) || value.length > MAX_REQUIREMENTS)
    throw new PackageOperationError("invalid_requirement");
  // Full PEP 508 syntax is parsed by micropip's pinned packaging parser.
  // Block direct URLs/path syntax before it can influence acquisition.
  if (
    value.some(
      (req) =>
        typeof req !== "string" ||
        req.length > 256 ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]*(?:\[|\s|[<>=!~;]|$)/.test(req) ||
        /[@:/\\]/.test(req) ||
        [...req].some((character) => character.charCodeAt(0) < 32),
    )
  ) {
    throw new PackageOperationError("invalid_requirement");
  }
  return [...value];
}

function cleanUrl(value, host) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.hostname !== host ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.href !== value
  )
    throw new Error("Unsupported package source");
  return url;
}

export function validateLockedWheel(value) {
  if (!value || typeof value !== "object") throw new Error("Invalid package lock");
  const { name, version, filename, url, sha256, size } = value;
  if (
    typeof name !== "string" ||
    !/^[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?$/.test(name) ||
    name.length > 128 ||
    typeof version !== "string" ||
    !/^[a-zA-Z0-9.!+_-]{1,80}$/.test(version) ||
    typeof filename !== "string" ||
    !/^[A-Za-z0-9_.+-]+-py[23](?:\.py[23])*-none-any\.whl$/.test(filename) ||
    !/^[a-f0-9]{64}$/.test(sha256) ||
    !Number.isSafeInteger(size) ||
    size < 1 ||
    size > MAX_WHEEL_BYTES
  )
    throw new Error("Only bounded pure Python wheels are supported");
  const parsed = cleanUrl(url, "files.pythonhosted.org");
  if (
    !/^\/packages\/[a-f0-9]{2}\/[a-f0-9]{2}\/[a-f0-9]+\//.test(parsed.pathname) ||
    parsed.pathname.split("/").at(-1) !== filename
  )
    throw new Error("Unsupported wheel source");
  if (
    filename.split("-")[0].toLowerCase().replace(/[_.]+/g, "-") !== name ||
    filename.split("-")[1] !== version
  )
    throw new Error("Wheel identity mismatch");
  const dependencies = value.dependencies ?? [];
  if (
    !Array.isArray(dependencies) ||
    dependencies.length > 128 ||
    dependencies.some(
      (name) => typeof name !== "string" || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(name),
    )
  )
    throw new Error("Invalid wheel dependencies");
  return { name, version, filename, url, sha256, size, dependencies };
}

async function readBounded(response, limit) {
  if (!response.ok || response.redirected) throw new Error("Package download failed");
  if (Number(response.headers.get("content-length")) > limit)
    throw new Error("Package size limit exceeded");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new Error("Package size limit exceeded");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

function base64(bytes) {
  let result = "";
  for (let i = 0; i < bytes.length; i += 8192)
    result += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(result);
}

/** A request-scoped acquisition budget; only the trusted provider owns fetch. */
export class PackageAcquisition {
  #fetch;
  #signal;
  #used = 0;
  #approved = new Map();
  #wheels = new Map();
  constructor({ fetchImpl = fetch, signal } = {}) {
    this.#fetch = fetchImpl;
    this.#signal = signal;
  }

  async #read(url, limit) {
    this.#signal?.throwIfAborted();
    const response = await this.#fetch(url, {
      method: "GET",
      redirect: "error",
      credentials: "omit",
      signal: this.#signal,
    });
    const bytes = await readBounded(response, Math.min(limit, MAX_TOTAL_BYTES - this.#used));
    this.#used += bytes.length;
    this.#signal?.throwIfAborted();
    return bytes;
  }

  async acquire(url) {
    const metadata = /^https:\/\/pypi\.org\/pypi\/([a-z0-9][a-z0-9-]{0,127})\/json$/.exec(url);
    if (metadata) {
      cleanUrl(url, "pypi.org");
      const source = JSON.parse(
        new TextDecoder().decode(await this.#read(url, MAX_METADATA_BYTES)),
      );
      const name = metadata[1];
      const releases = {};
      for (const [version, entries] of Object.entries(source.releases ?? {})) {
        if (!Array.isArray(entries)) continue;
        const accepted = [];
        for (const entry of entries) {
          try {
            const wheel = validateLockedWheel({
              name,
              version,
              filename: entry.filename,
              url: entry.url,
              sha256: entry.digests?.sha256,
              size: entry.size,
            });
            this.#approved.set(wheel.url, wheel);
            accepted.push({
              filename: wheel.filename,
              url: wheel.url,
              size: wheel.size,
              digests: { sha256: wheel.sha256 },
              requires_python: entry.requires_python,
              yanked: entry.yanked,
            });
          } catch {
            /* Native, source, oversized and foreign-origin artifacts are unsupported. */
          }
        }
        if (accepted.length) releases[version] = accepted;
      }
      return { url, body: JSON.stringify({ info: { name }, releases }) };
    }
    const wheel = this.#approved.get(url);
    if (!wheel) throw new Error("Resolver requested an unapproved artifact");
    return this.download(wheel);
  }

  async download(value) {
    const wheel = validateLockedWheel(value);
    if (this.#wheels.has(wheel.url)) return this.#wheels.get(wheel.url);
    if (this.#wheels.size >= MAX_WHEELS) throw new Error("Package count limit exceeded");
    const bytes = await this.#read(wheel.url, wheel.size);
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
    if (bytes.length !== wheel.size || hash !== wheel.sha256)
      throw new Error("Package integrity check failed");
    const result = { ...wheel, body: base64(bytes) };
    this.#wheels.set(wheel.url, result);
    return result;
  }

  selected(wheels) {
    if (!Array.isArray(wheels) || wheels.length > MAX_WHEELS)
      throw new Error("Invalid package plan");
    return wheels.map((planned) => {
      const verified = this.#wheels.get(planned.url);
      if (!verified || planned.name !== verified.name || planned.version !== verified.version)
        throw new Error("Package plan does not match verified artifacts");
      return {
        ...verified,
        dependencies: validateLockedWheel({ ...verified, dependencies: planned.dependencies })
          .dependencies,
      };
    });
  }
}

/** One disposable, offline planning interpreter per deployment at a time.
 * It never receives notebook source, state, credentials or tenant callbacks.
 */
export class PackageResolver {
  #create;
  #fetch;
  #busy = false;
  #retained = false;
  get status() {
    return this.#retained ? "recovery_required" : this.#busy ? "busy" : "ready";
  }
  constructor({ create, fetchImpl = fetch }) {
    this.#create = create;
    this.#fetch = fetchImpl;
  }

  async resolve(requirements, { constraints = [], signal } = {}) {
    validateRequirements(requirements);
    validateRequirements(constraints);
    if (this.#busy)
      throw new PackageOperationError(this.#retained ? "planner_unavailable" : "planner_busy");
    this.#busy = true;
    let planner;
    let retained = false;
    let cleanup;
    const disposePlanner = () => {
      // Abort and finally can overlap while host termination is pending.
      // Both must await the same cleanup result, including an unknown result.
      if (!planner) return Promise.resolve();
      cleanup ??= Promise.resolve().then(() => planner.dispose());
      return cleanup;
    };
    const deadline = AbortSignal.timeout(PACKAGE_ACQUISITION_MS);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const terminate = () => {
      void disposePlanner().catch(() => {
        retained = true;
      });
    };
    combined.addEventListener("abort", terminate, { once: true });
    try {
      planner = await this.#create();
      combined.throwIfAborted();
      const acquisition = new PackageAcquisition({ fetchImpl: this.#fetch, signal: combined });
      let artifact;
      for (let step = 0; step < MAX_STEPS; step++) {
        combined.throwIfAborted();
        const result = await planner.plan({ requirements, constraints, artifact });
        combined.throwIfAborted();
        if (result.status === "ready")
          return { requirements, wheels: acquisition.selected(result.wheels) };
        if (result.status === "error")
          throw new PackageOperationError(
            result.code === "incompatible" ? "incompatible" : "unavailable",
          );
        if (result.status !== "fetch" || typeof result.url !== "string")
          throw new Error("Invalid package resolver response");
        artifact = await acquisition.acquire(result.url);
      }
      throw new PackageOperationError("resolution_limit");
    } catch (error) {
      if (error?.runtimeRetained) retained = true;
      throw error;
    } finally {
      combined.removeEventListener("abort", terminate);
      try {
        await disposePlanner();
      } catch {
        retained = true;
      }
      // Unknown cleanup retains this single reservation until provider restart.
      this.#busy = retained;
      this.#retained = retained;
      if (retained)
        console.warn(
          JSON.stringify({ event: "python.package_planner.cleanup_unconfirmed", retained: true }),
        );
    }
  }
}
