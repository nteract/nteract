/**
 * Runtime package installs for the pyodide execution worker.
 *
 * `micropip.install` from PyPI with a wheel cache persisted to the fleet's
 * object storage (R2 binding) so repeat loads stay fast. Only pure-python and
 * `pyemscripten_*` wheels are installable; anything
 * else fails with a structured error that the execution loop maps onto the
 * triggering cell.
 */

/** Object-storage subset the worker receives (R2 binding or dev in-memory). */
export interface WheelCacheStore {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, body: Uint8Array): Promise<void>;
}

export interface MicropipAPI {
  install(requirements: string | string[], keep_going?: boolean): Promise<void>;
}

/** Install-progress event shapes for the RuntimeStateDoc env.progress channel.
 * Phase names match the serde-flattened `EnvProgressPhase` encoding the
 * frontend projection reads. */
export type InstallProgressPhase = "installing_packages" | "install_complete" | "error";

export interface InstallProgressEvent {
  phase: InstallProgressPhase;
  packages: string[];
  message?: string;
  elapsedMs?: number;
}

/**
 * Map a raw micropip failure to one actionable, traceback-free line naming
 * the offending requirement. Mirrors `summarize_install_error` in
 * `crates/runtimed/src/pyodide_kernel.rs`.
 */
export function summarizeInstallError(error: string, packages: string[]): string {
  const quotedAfter = (haystack: string, marker: string): string | null => {
    const start = haystack.indexOf(marker);
    if (start === -1) return null;
    const rest = haystack.slice(start + marker.length);
    const end = rest.indexOf("'");
    return end === -1 ? null : rest.slice(0, end).trim();
  };

  const metadataName = quotedAfter(error, "Can't fetch metadata for '");
  if (metadataName !== null) {
    return `Package '${metadataName}' could not be resolved — check the package name and spelling.`;
  }

  const lowered = error.toLowerCase();
  if (
    lowered.includes("can't find a pure python 3 wheel") ||
    lowered.includes("unsupported wheel")
  ) {
    const name =
      (packages[0] ? packages[0].split(/[>=<!~;[\] ()]/)[0] : null) ??
      quotedAfter(error, "pure Python 3 wheel for '") ??
      "the requested package";
    return `Package '${name}' has no pyodide-compatible wheel (needs a pure-python or pyemscripten build).`;
  }

  const lastLine = error
    .split("\n")
    .reverse()
    .find((line) => line.trim().length > 0);
  return lastLine?.trim() || "Package install failed";
}

export interface PyodidePackagesHost {
  /** `import micropip` after the interpreter is ready. */
  importMicropip(): Promise<MicropipAPI>;
  /**
   * Fetch override the interpreter uses for wheel downloads. Receives the
   * micropip-resolved wheel URL; the worker consults the cache first and
   * stores misses. Returning null falls through to the host fetch.
   */
  setWheelFetcher(fetcher: (url: string) => Promise<Response>): void;
  /**
   * Optional install-progress sink. The room-attach layer wires this to
   * RuntimeStateDoc env.progress writes under its policy-allowed runtime-peer
   * scope; the attach loop is not yet implemented in the worker, so this
   * stays optional.
   */
  onInstallProgress?(progress: InstallProgressEvent): void;
}

export class WheelCache {
  constructor(
    private readonly store: WheelCacheStore,
    private readonly fetchImpl: (url: string) => Promise<Response> = fetch,
  ) {}

  private keyFor(url: string): string {
    return `pyodide-wheel:${url}`;
  }

  async get(url: string): Promise<Response | null> {
    const body = await this.store.get(this.keyFor(url));
    if (body === null) return null;
    return new Response(body as unknown as BodyInit, {
      status: 200,
      headers: { "content-type": "application/octet-stream" },
    });
  }

  /** Cache-hit installs serve in ≤ 1 s (R13); misses go through PyPI/CDN. */
  async fetchWheel(url: string): Promise<Response> {
    const cached = await this.get(url);
    if (cached !== null) return cached;
    const response = await this.fetchImpl(url);
    if (response.ok) {
      const body = new Uint8Array(await response.arrayBuffer());
      await this.store.put(this.keyFor(url), body);
      return new Response(body as unknown as BodyInit, {
        status: 200,
        headers: response.headers,
      });
    }
    return response;
  }
}

/** Structured failure for packages without an installable wheel. */
export class UninstallablePackageError extends Error {
  readonly ename = "MicropipPackageError";

  constructor(micropipMessage: string) {
    super(micropipMessage);
  }
}

/**
 * Install packages through micropip, routing wheel fetches through the cache.
 * Non-installable packages surface as {@link UninstallablePackageError}; the
 * execution loop maps that onto a structured error output for the cell that
 * triggered the install (spec edge case).
 */
export async function installPackages(
  host: PyodidePackagesHost,
  cache: WheelCache,
  requirements: string[],
): Promise<void> {
  const micropip = await host.importMicropip();
  host.setWheelFetcher((url) => cache.fetchWheel(url));
  const startedAt = Date.now();
  host.onInstallProgress?.({ phase: "installing_packages", packages: requirements });
  try {
    await micropip.install(requirements, false);
    host.onInstallProgress?.({
      phase: "install_complete",
      packages: requirements,
      elapsedMs: Date.now() - startedAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const summarized = summarizeInstallError(message, requirements);
    host.onInstallProgress?.({
      phase: "error",
      packages: requirements,
      message: summarized,
    });
    if (/Can't find a pure Python 3 wheel|Unsupported wheel/i.test(message)) {
      throw new UninstallablePackageError(summarized);
    }
    throw error;
  }
}

/** In-memory cache store for local/dev workers without an R2 binding. */
export class InMemoryWheelCacheStore implements WheelCacheStore {
  private readonly entries = new Map<string, Uint8Array>();

  async get(key: string): Promise<Uint8Array | null> {
    return this.entries.get(key) ?? null;
  }

  async put(key: string, body: Uint8Array): Promise<void> {
    this.entries.set(key, body);
  }
}
