import type { Env, ExecutionContext } from "./cloudflare-types.ts";

export type LatestWorkstationBuildChannel = "stable" | "nightly";

export interface LatestWorkstationBuild {
  version: string;
  pubDate: string | null;
}

export type LatestWorkstationBuildMap = Partial<
  Record<LatestWorkstationBuildChannel, LatestWorkstationBuild | null>
>;

export type LatestWorkstationBuildVersionMap = Record<LatestWorkstationBuildChannel, string | null>;

export interface LatestWorkstationBuildLookupOptions {
  baseUrl?: string | null;
  fetchImpl?: typeof fetch;
  nowMs?: number;
  waitUntil?: (promise: Promise<unknown>) => void;
}

const LATEST_WORKSTATION_BUILD_CHANNELS = ["stable", "nightly"] as const;
const DEFAULT_LATEST_WORKSTATION_BUILD_BASE_URL =
  "https://github.com/nteract/nteract/releases/download";
const LATEST_WORKSTATION_BUILD_TTL_MS = 15 * 60_000;
const LATEST_WORKSTATION_BUILD_FAILURE_RETRY_MS = 60_000;
const LATEST_WORKSTATION_BUILD_FETCH_TIMEOUT_MS = 2_000;

interface LatestWorkstationBuildCacheEntry {
  value: LatestWorkstationBuild | null;
  expiresAt: number;
  ready?: Promise<LatestWorkstationBuild | null>;
}

const latestWorkstationBuildCache = new Map<string, LatestWorkstationBuildCacheEntry>();

export async function getLatestWorkstationBuildsForEnv(
  env: Env,
  ctx: ExecutionContext,
  options: Omit<LatestWorkstationBuildLookupOptions, "baseUrl" | "waitUntil"> = {},
): Promise<LatestWorkstationBuildMap> {
  return getLatestWorkstationBuilds({
    ...options,
    baseUrl: latestWorkstationBuildBaseUrl(env),
    waitUntil: (promise) => ctx.waitUntil(promise),
  });
}

export async function getLatestWorkstationBuilds({
  baseUrl = DEFAULT_LATEST_WORKSTATION_BUILD_BASE_URL,
  fetchImpl = fetch,
  nowMs = Date.now(),
  waitUntil,
}: LatestWorkstationBuildLookupOptions = {}): Promise<LatestWorkstationBuildMap> {
  const normalizedBaseUrl = normalizeLatestWorkstationBuildBaseUrl(baseUrl);
  if (!normalizedBaseUrl) {
    return {};
  }

  const entries = await Promise.all(
    LATEST_WORKSTATION_BUILD_CHANNELS.map(async (channel) => [
      channel,
      await getLatestWorkstationBuild(channel, {
        baseUrl: normalizedBaseUrl,
        fetchImpl,
        nowMs,
        waitUntil,
      }),
    ]),
  );
  return Object.fromEntries(entries) as LatestWorkstationBuildMap;
}

export function latestWorkstationBuildVersionsByChannel(
  builds: LatestWorkstationBuildMap,
): LatestWorkstationBuildVersionMap {
  return {
    stable: builds.stable?.version ?? null,
    nightly: builds.nightly?.version ?? null,
  };
}

export function latestWorkstationBuildForChannel(
  builds: LatestWorkstationBuildMap | null | undefined,
  channel: string | null | undefined,
): string | null {
  const normalized = normalizeLatestWorkstationBuildChannel(channel);
  return normalized ? (builds?.[normalized]?.version ?? null) : null;
}

export function isWorkstationBuildOutdated(
  installedBuild: string | null | undefined,
  latestBuild: string | null | undefined,
): boolean {
  const installed = parseBuildVersion(installedBuild);
  const latest = parseBuildVersion(latestBuild);
  if (!installed || !latest) {
    return false;
  }
  return compareBuildVersions(installed, latest) < 0;
}

export function clearLatestWorkstationBuildCacheForTests(): void {
  latestWorkstationBuildCache.clear();
}

function latestWorkstationBuildBaseUrl(env: Env): string | null {
  return normalizeLatestWorkstationBuildBaseUrl(
    env.NOTEBOOK_CLOUD_WORKSTATION_LATEST_BUILD_BASE_URL ??
      DEFAULT_LATEST_WORKSTATION_BUILD_BASE_URL,
  );
}

function normalizeLatestWorkstationBuildBaseUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  const lowered = trimmed.toLowerCase();
  if (lowered === "disabled" || lowered === "off" || lowered === "none") {
    return null;
  }
  return trimmed.replace(/\/+$/, "");
}

function normalizeLatestWorkstationBuildChannel(
  channel: string | null | undefined,
): LatestWorkstationBuildChannel | null {
  const normalized = channel?.trim().toLowerCase();
  return normalized === "stable" || normalized === "nightly" ? normalized : null;
}

async function getLatestWorkstationBuild(
  channel: LatestWorkstationBuildChannel,
  options: Required<Pick<LatestWorkstationBuildLookupOptions, "fetchImpl" | "nowMs">> & {
    baseUrl: string;
    waitUntil?: (promise: Promise<unknown>) => void;
  },
): Promise<LatestWorkstationBuild | null> {
  const key = latestWorkstationBuildCacheKey(options.baseUrl, channel);
  const cached = latestWorkstationBuildCache.get(key);
  if (cached && cached.expiresAt > options.nowMs) {
    return cached.value;
  }
  if (cached?.value) {
    const refresh = refreshLatestWorkstationBuild(key, channel, cached.value, options);
    options.waitUntil?.(refresh.then(() => undefined));
    return cached.value;
  }
  return refreshLatestWorkstationBuild(key, channel, cached?.value ?? null, options);
}

function refreshLatestWorkstationBuild(
  key: string,
  channel: LatestWorkstationBuildChannel,
  fallback: LatestWorkstationBuild | null,
  options: Required<Pick<LatestWorkstationBuildLookupOptions, "fetchImpl" | "nowMs">> & {
    baseUrl: string;
  },
): Promise<LatestWorkstationBuild | null> {
  const current = latestWorkstationBuildCache.get(key);
  if (current?.ready) {
    return current.ready;
  }

  let ready: Promise<LatestWorkstationBuild | null>;
  ready = fetchLatestWorkstationBuild(channel, options)
    .then((value) => {
      latestWorkstationBuildCache.set(key, {
        value,
        expiresAt: options.nowMs + LATEST_WORKSTATION_BUILD_TTL_MS,
        ready,
      });
      return value;
    })
    .catch(() => {
      const stale = latestWorkstationBuildCache.get(key)?.value ?? fallback;
      latestWorkstationBuildCache.set(key, {
        value: stale,
        expiresAt: options.nowMs + LATEST_WORKSTATION_BUILD_FAILURE_RETRY_MS,
        ready,
      });
      return stale;
    })
    .finally(() => {
      const latest = latestWorkstationBuildCache.get(key);
      if (latest?.ready === ready) {
        latest.ready = undefined;
      }
    });

  latestWorkstationBuildCache.set(key, {
    value: fallback,
    expiresAt: current?.expiresAt ?? 0,
    ready,
  });
  return ready;
}

async function fetchLatestWorkstationBuild(
  channel: LatestWorkstationBuildChannel,
  {
    baseUrl,
    fetchImpl,
  }: Required<Pick<LatestWorkstationBuildLookupOptions, "fetchImpl">> & {
    baseUrl: string;
  },
): Promise<LatestWorkstationBuild | null> {
  const response = await fetchImpl(`${baseUrl}/${channel}-latest/latest.json`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(LATEST_WORKSTATION_BUILD_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`latest ${channel} build fetch failed with status ${response.status}`);
  }
  const payload = (await response.json()) as Record<string, unknown>;
  const version = boundedString(payload.version, 160);
  if (!version) {
    return null;
  }
  return {
    version,
    pubDate: boundedString(payload.pub_date ?? payload.pubDate, 80),
  };
}

function latestWorkstationBuildCacheKey(
  baseUrl: string,
  channel: LatestWorkstationBuildChannel,
): string {
  return `${baseUrl}\0${channel}`;
}

function boundedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maxLength ? trimmed : null;
}

interface ParsedBuildVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: readonly string[];
}

function parseBuildVersion(value: string | null | undefined): ParsedBuildVersion | null {
  const normalized = value?.trim().replace(/\+.*/, "");
  if (!normalized) {
    return null;
  }
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?$/.exec(normalized);
  if (!match) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2] ?? 0),
    patch: Number(match[3] ?? 0),
    prerelease: match[4] ? match[4].split(".").filter(Boolean) : [],
  };
}

function compareBuildVersions(left: ParsedBuildVersion, right: ParsedBuildVersion): number {
  for (const key of ["major", "minor", "patch"] as const) {
    const delta = left[key] - right[key];
    if (delta !== 0) {
      return delta;
    }
  }
  if (left.prerelease.length === 0 && right.prerelease.length === 0) {
    return 0;
  }
  if (left.prerelease.length === 0) {
    return 1;
  }
  if (right.prerelease.length === 0) {
    return -1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    const delta = comparePrereleaseIdentifier(leftPart, rightPart);
    if (delta !== 0) {
      return delta;
    }
  }
  return 0;
}

function comparePrereleaseIdentifier(left: string, right: string): number {
  const leftNumeric = /^[0-9]+$/.test(left);
  const rightNumeric = /^[0-9]+$/.test(right);
  if (leftNumeric && rightNumeric) {
    return Number(left) - Number(right);
  }
  if (leftNumeric) {
    return -1;
  }
  if (rightNumeric) {
    return 1;
  }
  return left < right ? -1 : left > right ? 1 : 0;
}
