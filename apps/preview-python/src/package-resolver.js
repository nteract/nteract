import { defer, firstValueFrom, ReplaySubject, share } from "rxjs";
import { PACKAGE_ACQUISITION_MS } from "./package-limits.js";

const MAX_WHEEL_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 24 * 1024 * 1024;
const MAX_METADATA_BYTES = 8 * 1024 * 1024;
const MAX_STEPS = 64;
const MAX_WHEELS = 32;
const MAX_REQUIREMENTS = 64;
const MAX_WARM_PLANNERS = 4;

const PACKAGE_ERRORS = Object.freeze({
  invalid_requirement:
    "Use a PyPI package name with optional version constraints or extras. Wheel URLs and local paths are unsupported.",
  planner_busy: "Another package installation is being prepared. Try again shortly.",
  planner_failed:
    "The package service is unavailable and requires its runtime provider to restart. Restarting Python in this notebook will not reset the package service.",
  incompatible:
    "A requested version conflicts with an included package. The included scientific package versions are fixed.",
  unavailable:
    "No compatible package set was found. Check the requested versions and dependency constraints; additional packages need supported pure Python wheels.",
  unsupported_distribution:
    "A package or dependency has no distribution supported by hosted Python. Additional packages need pure Python wheels within the download limits. Compiled packages must be listed under Included with Python; others require an updated hosted runtime or a local Python environment.",
  package_not_found: "A package or dependency was not found on PyPI. Check the package name.",
  metadata_failed: "Package information could not be retrieved from PyPI. Try again shortly.",
  acquisition_limit:
    "Package information or downloads exceed the hosted size limits. Try fewer requirements or use a local Python environment.",
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

async function readBounded(response, limit, oversized) {
  if (!response.ok || response.redirected) throw new Error("Package download failed");
  if (Number(response.headers.get("content-length")) > limit) throw oversized;
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
        throw oversized;
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

  async #read(url, limit, { metadata = false } = {}) {
    this.#signal?.throwIfAborted();
    const response = await this.#fetch(url, {
      method: "GET",
      redirect: "error",
      credentials: "omit",
      signal: this.#signal,
    });
    if (metadata && response.status === 404 && !response.redirected)
      throw new PackageOperationError("package_not_found");
    const remaining = MAX_TOTAL_BYTES - this.#used;
    const oversized =
      metadata || remaining < limit
        ? new PackageOperationError("acquisition_limit")
        : new Error("Package integrity check failed");
    const bytes = await readBounded(response, Math.min(limit, remaining), oversized);
    this.#used += bytes.length;
    this.#signal?.throwIfAborted();
    return bytes;
  }

  async acquire(url) {
    const metadata = /^https:\/\/pypi\.org\/pypi\/([a-z0-9][a-z0-9-]{0,127})\/json$/.exec(url);
    if (metadata) {
      cleanUrl(url, "pypi.org");
      let source;
      try {
        source = JSON.parse(
          new TextDecoder().decode(await this.#read(url, MAX_METADATA_BYTES, { metadata: true })),
        );
        if (
          !source?.releases ||
          typeof source.releases !== "object" ||
          Array.isArray(source.releases)
        )
          throw new Error("Invalid package metadata");
      } catch (error) {
        this.#signal?.throwIfAborted();
        if (error instanceof PackageOperationError) throw error;
        throw new PackageOperationError("metadata_failed");
      }
      const name = metadata[1];
      const releases = {};
      let distributions = 0;
      for (const [version, entries] of Object.entries(source.releases ?? {})) {
        if (!Array.isArray(entries)) continue;
        distributions += entries.length;
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
      // The trusted catalog was fetched successfully but every artifact was
      // filtered out. Do not turn missing compiled support into a solver or
      // network error in the offline planner.
      if (distributions > 0 && Object.keys(releases).length === 0)
        throw new PackageOperationError("unsupported_distribution");
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

/** One warm, offline planning interpreter per deployment.
 * It never receives notebook source, state, credentials or tenant callbacks.
 */
const PLANNER_RECOVERY_TTL_MS = 300_000;
const PLANNER_RECOVERY_ATTEMPTS = 5;

export class PackageResolver {
  #create;
  #fetch;
  #clock;
  #sessions = new Map();
  get status() {
    return [...this.#sessions.values()].some((session) => session.busy) ? "busy" : "ready";
  }
  constructor({ create, fetchImpl = fetch, clock = Date.now }) {
    this.#create = create;
    this.#fetch = fetchImpl;
    this.#clock = clock;
  }

  #session(sessionKey) {
    let session = this.#sessions.get(sessionKey);
    if (!session) {
      const activeSessions = [...this.#sessions.values()].filter(
        (candidate) =>
          !candidate.closed || candidate.stray || candidate.planner || candidate.closing,
      ).length;
      if (activeSessions >= MAX_WARM_PLANNERS) throw new PackageOperationError("planner_busy");
      session = {
        planner: undefined,
        busy: false,
        stray: undefined,
        recovering: undefined,
        closed: false,
      };
      this.#sessions.set(sessionKey, session);
    }
    return session;
  }

  async #recover(sessionKey, session) {
    const stray = session.stray;
    if (!stray) return;
    if (session.recovering) return session.recovering;
    if (
      stray.attempts >= PLANNER_RECOVERY_ATTEMPTS ||
      this.#clock() - stray.since >= PLANNER_RECOVERY_TTL_MS
    ) {
      session.quarantined = true;
      console.warn(
        JSON.stringify({
          event: "python.package_planner.quarantined",
          notebook_session: sessionKey,
          attempts: stray.attempts,
        }),
      );
      return;
    }
    session.recovering = (async () => {
      try {
        if (typeof stray.dispose !== "function")
          throw new Error("Planner termination cannot be confirmed without a retry handle");
        await stray.dispose();
      } catch {
        stray.attempts += 1;
        console.warn(
          JSON.stringify({
            event: "python.package_planner.cleanup_unconfirmed",
            notebook_session: sessionKey,
            retained: true,
          }),
        );
        return;
      }
      session.stray = undefined;
      if (session.closed) this.#sessions.delete(sessionKey);
    })().finally(() => {
      session.recovering = undefined;
    });
    return session.recovering;
  }

  async recover() {
    await Promise.all(
      [...this.#sessions.entries()].map(([sessionKey, session]) =>
        this.#recover(sessionKey, session),
      ),
    );
  }

  async expireClosedSessions() {
    for (const [sessionKey, session] of this.#sessions)
      if (session.closed && !session.busy) await this.disposeSession(sessionKey);
  }

  async disposeSession(sessionKey) {
    const session = this.#sessions.get(sessionKey);
    if (!session) return;
    session.closed = true;
    if (session.busy) return;
    if (session.closing) return session.closing;
    const planner = session.planner;
    session.planner = undefined;
    if (!planner) {
      if (!session.stray) this.#sessions.delete(sessionKey);
      return;
    }
    session.closing = Promise.resolve()
      .then(() => planner.dispose())
      .then(() => {
        if (!session.stray) this.#sessions.delete(sessionKey);
      })
      .catch(() => {
        session.stray = { dispose: () => planner.dispose(), since: this.#clock(), attempts: 0 };
        console.warn(
          JSON.stringify({
            event: "python.package_planner.cleanup_unconfirmed",
            notebook_session: sessionKey,
            retained: true,
          }),
        );
      })
      .finally(() => {
        session.closing = undefined;
      });
    return session.closing;
  }

  async resolve(sessionKey, requirements, { constraints = [], signal } = {}) {
    validateRequirements(requirements);
    validateRequirements(constraints);
    const session = this.#session(sessionKey);
    if (session.quarantined) throw new PackageOperationError("planner_failed");
    if (session.stray && typeof session.stray.dispose !== "function") {
      session.stray.attempts++;
      throw new PackageOperationError("planner_failed");
    }
    const deadline = AbortSignal.timeout(PACKAGE_ACQUISITION_MS);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    while (session.stray) {
      combined.throwIfAborted();
      await this.#recover(sessionKey, session);
      if (session.quarantined) throw new PackageOperationError("planner_failed");
      if (session.stray) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (session.quarantined) throw new PackageOperationError("planner_failed");
    if (session.busy || session.closed) throw new PackageOperationError("planner_busy");
    session.busy = true;
    let planner = session.planner;
    let cleanup$;
    const disposeOnce = () => {
      cleanup$ ??= defer(() => (planner ? planner.dispose() : Promise.resolve())).pipe(
        share({
          connector: () => new ReplaySubject(1),
          resetOnError: true,
          resetOnComplete: false,
          resetOnRefCountZero: false,
        }),
      );
      return firstValueFrom(cleanup$);
    };
    const terminate = () => {
      if (!planner) return;
      if (session.planner === planner) session.planner = undefined;
      session.stray = { dispose: () => disposeOnce(), since: this.#clock(), attempts: 0 };
      void disposeOnce().then(
        () => {
          session.stray = undefined;
          if (session.closed) this.#sessions.delete(sessionKey);
        },
        () => this.#logCleanupFailure(sessionKey),
      );
    };
    combined.addEventListener("abort", terminate, { once: true });
    try {
      if (!planner) {
        try {
          planner = await this.#create();
          session.planner = planner;
        } catch (error) {
          if (error?.runtimeRetained)
            session.stray = {
              dispose: error.retryTermination,
              since: this.#clock(),
              attempts: 0,
            };
          throw error;
        }
      }
      combined.throwIfAborted();
      const acquisition = new PackageAcquisition({ fetchImpl: this.#fetch, signal: combined });
      let artifact;
      for (let step = 0; step < MAX_STEPS; step++) {
        combined.throwIfAborted();
        const result = await planner.plan({
          requirements,
          constraints,
          artifact,
          reset: step === 0,
        });
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
      if (error?.runtimeRetained || error?.cause?.runtimeInvalidated) {
        if (session.planner === planner) session.planner = undefined;
        session.stray = {
          dispose: planner ? () => disposeOnce() : error.retryTermination,
          since: this.#clock(),
          attempts: 0,
        };
      } else if (!(error instanceof PackageOperationError) && session.planner === planner) {
        // Unknown planner exceptions make its state unsafe to reuse. Package
        // errors such as not-found are expected results and preserve the warm planner.
        session.planner = undefined;
        try {
          await disposeOnce();
        } catch {
          session.stray = { dispose: () => disposeOnce(), since: this.#clock(), attempts: 0 };
        }
      }
      throw error;
    } finally {
      combined.removeEventListener("abort", terminate);
      session.busy = false;
      if (session.closed)
        void this.disposeSession(sessionKey).catch((error) => {
          console.warn(
            JSON.stringify({
              event: "python.package_planner.closed_session_cleanup_failed",
              notebook_session: sessionKey,
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        });
    }
  }

  #logCleanupFailure(sessionKey) {
    console.warn(
      JSON.stringify({
        event: "python.package_planner.cleanup_unconfirmed",
        notebook_session: sessionKey,
        retained: true,
      }),
    );
  }
}
