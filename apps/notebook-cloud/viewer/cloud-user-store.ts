/**
 * Cloud viewer user store: the single owner of the principal-keyed display
 * directory used to resolve notebook actor labels to names and avatars. The
 * cache is keyed by principal rather than notebook so switching notebooks can
 * retain known identities while each backfill still uses the current
 * notebook-scoped, relationship-gated author-profiles endpoint.
 *
 * The store is a module-level source store because presence, comments,
 * dashboard, and shell surfaces must converge on one identity cache instead of
 * rebuilding peer directories per component. React reads the narrow domain hook;
 * the store owns precedence, never-demote merging, presence/self seeding, and
 * async stale-write guards.
 *
 * The drivers live behind `activate(inputs$, deps)` and `connectPresence(...)`.
 * Network operations and any future timers are injectable, so the whole store is
 * virtual-time-total and node-testable without a browser.
 */

import { Subscription, type Observable, type SchedulerLike } from "rxjs";
import {
  ObservableStore,
  notebookActorProjectionFromLabel,
  resolveActorDisplay,
  type ActorDisplay,
} from "runtimed";
import type { ActorDisplayPeer } from "runtimed";
import {
  COMMENT_AUTHOR_PROFILE_LOOKUP_BATCH_SIZE,
  commentAuthorProfilesUrl,
} from "./comment-author-profiles";
import type { CloudPrototypeAuthState } from "./collaborator-auth";
import type { CloudViewerPresenceState, CloudViewerPresenceStore } from "./presence";

export interface CloudResolvedProfile {
  principal: string;
  displayName: string | null;
  avatarUrl: string | null;
  source: "self" | "presence" | "profile" | "unresolved";
}

export interface CloudUserDirectoryState {
  profiles: ReadonlyMap<string, CloudResolvedProfile>;
}

export interface CloudUserStoreInputs {
  /** Browser auth identity; signed-out transitions invalidate cached identity. */
  auth: CloudPrototypeAuthState;
  /** Notebook-scoped author-profiles endpoint; null on routes with no notebook. */
  authorProfilesEndpoint: string | null;
}

export interface CloudUserStoreDeps {
  scheduler?: SchedulerLike;
  now?: () => number;
  fetchProfiles?: (url: string, signal?: AbortSignal) => Promise<Response>;
}

interface ResolvedCloudUserStoreDeps {
  fetchProfiles: NonNullable<CloudUserStoreDeps["fetchProfiles"]>;
}

interface BackfillIssue {
  epoch: number;
  endpoint: string;
}

interface ParsedProfileEntry {
  principal: string;
  displayName: string | null;
  avatarUrl: string | null;
  resolved: boolean;
}

const EMPTY_STATE: CloudUserDirectoryState = {
  profiles: new Map(),
};

const SOURCE_RANK: Record<CloudResolvedProfile["source"], number> = {
  profile: 3,
  self: 2,
  presence: 1,
  unresolved: 0,
};

function defaultFetchProfiles(url: string, signal?: AbortSignal): Promise<Response> {
  if (typeof fetch !== "function") {
    return Promise.reject(new Error("fetch is unavailable"));
  }
  return fetch(url, { signal });
}

function profileEquals(a: CloudResolvedProfile, b: CloudResolvedProfile): boolean {
  return (
    a === b ||
    (a.principal === b.principal &&
      a.displayName === b.displayName &&
      a.avatarUrl === b.avatarUrl &&
      a.source === b.source)
  );
}

function principalFromActorLabel(actorLabel: string | null | undefined): string | null {
  const trimmed = actorLabel?.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return notebookActorProjectionFromLabel(trimmed, {
      source: "cloud",
      isPublic: trimmed.startsWith("anonymous:"),
    }).principal.id;
  } catch {
    return null;
  }
}

function authDisplayName(auth: CloudPrototypeAuthState): string | null {
  const claimName = auth.oidcClaims?.name?.trim();
  if (claimName) {
    return claimName;
  }
  const claimEmail = auth.oidcClaims?.email?.trim();
  if (claimEmail) {
    return claimEmail;
  }
  const user = auth.user?.trim();
  return user || null;
}

function authAvatarUrl(auth: CloudPrototypeAuthState): string | null {
  return auth.oidcClaims?.picture?.trim() || null;
}

function signedOut(auth: CloudPrototypeAuthState): boolean {
  // `oidc_expired` is mid-renewal: the principal is unchanged and instant paint
  // keeps rendering, so cached identities stay. Only a genuine identity loss
  // (anonymous, invalid) clears the directory.
  return auth.mode === "anonymous" || auth.mode === "invalid";
}

function usablePrincipal(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function usableLabel(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed || genericPresenceLabel(trimmed)) {
    return null;
  }
  return trimmed;
}

function genericPresenceLabel(label: string): boolean {
  switch (label) {
    case "Anonymous":
    case "Peer":
    case "Public viewer":
    case "Unknown viewer":
    case "User":
      return true;
    default:
      return false;
  }
}

function profileFromEntry(entry: ParsedProfileEntry): CloudResolvedProfile {
  return {
    principal: entry.principal,
    displayName: entry.resolved ? entry.displayName : null,
    avatarUrl: entry.resolved ? entry.avatarUrl : null,
    source: entry.resolved ? "profile" : "unresolved",
  };
}

function parseProfileEntry(value: unknown): ParsedProfileEntry | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const entry = value as {
    principal?: unknown;
    label?: unknown;
    image_url?: unknown;
    resolved?: unknown;
  };
  if (typeof entry.principal !== "string" || entry.principal.trim().length === 0) {
    return null;
  }
  if (typeof entry.resolved !== "boolean") {
    return null;
  }
  if (entry.label !== null && typeof entry.label !== "string") {
    return null;
  }
  if (
    entry.image_url !== undefined &&
    entry.image_url !== null &&
    typeof entry.image_url !== "string"
  ) {
    return null;
  }
  return {
    principal: entry.principal.trim(),
    displayName: entry.label?.trim() || null,
    avatarUrl: typeof entry.image_url === "string" ? entry.image_url.trim() || null : null,
    resolved: entry.resolved,
  };
}

function parseProfilesResponse(value: unknown): ParsedProfileEntry[] {
  if (!value || typeof value !== "object") {
    return [];
  }
  const profiles = (value as { profiles?: unknown }).profiles;
  if (!Array.isArray(profiles)) {
    return [];
  }
  return profiles.map(parseProfileEntry).filter((entry): entry is ParsedProfileEntry => !!entry);
}

export class CloudUserStore extends ObservableStore<CloudUserDirectoryState> {
  /** Principal-keyed profile directory. */
  readonly profiles$: Observable<ReadonlyMap<string, CloudResolvedProfile>>;

  private latestInputs: CloudUserStoreInputs | null = null;
  private resolvedDeps: ResolvedCloudUserStoreDeps | null = null;
  /**
   * Monotonic activation counter, bumped on every `activate`, its disposer, and
   * the signed-out gate. Backfill requests capture the epoch at issue time so a
   * completion that lands after teardown or identity loss cannot write profiles
   * into the current mount.
   */
  private activationEpoch = 0;
  private lastSignedOut: boolean | null = null;
  private lastEndpoint: string | null = null;
  private readonly inFlight = new Map<string, symbol>();
  /**
   * Principals the current endpoint answered "unresolved" for (or omitted).
   * Blocks refetch loops for presence-named principals that keep their seeded
   * entry, without demoting it. Endpoint-scoped: a different notebook is a
   * different relationship and may resolve what this one could not.
   */
  private readonly backfillMisses = new Set<string>();

  constructor() {
    super(EMPTY_STATE);
    this.profiles$ = this.select((state) => state.profiles);
  }

  profileFor$(principal: string): Observable<CloudResolvedProfile | undefined> {
    return this.select((state) => state.profiles.get(principal), Object.is);
  }

  /**
   * Start the user-store input driver and return a disposer. State is not reset
   * on activation because the cache is principal-keyed and intentionally
   * survives notebook route swaps; sign-out is the identity boundary that clears
   * it.
   */
  activate(inputs$: Observable<CloudUserStoreInputs>, deps: CloudUserStoreDeps = {}): () => void {
    const epoch = (this.activationEpoch += 1);
    const resolved = this.resolveDeps(deps);
    this.resolvedDeps = resolved;
    const subscription = new Subscription();

    subscription.add(
      inputs$.subscribe((inputs) => {
        this.latestInputs = inputs;
        if (inputs.authorProfilesEndpoint !== this.lastEndpoint) {
          // Unresolved is a per-relationship fact: a new notebook may resolve
          // what the previous one could not, so misses reset while named
          // profile/presence/self entries survive the route swap.
          this.lastEndpoint = inputs.authorProfilesEndpoint;
          this.backfillMisses.clear();
          this.dropUnresolvedEntries();
        }
        const isSignedOut = signedOut(inputs.auth);
        if (isSignedOut && this.lastSignedOut !== true) {
          // A signed-out transition invalidates every cached identity and every
          // async completion issued under the signed-in epoch.
          this.activationEpoch += 1;
          this.inFlight.clear();
          this.backfillMisses.clear();
          this.resetState(EMPTY_STATE);
        }
        this.lastSignedOut = isSignedOut;
      }),
    );

    return () => {
      if (this.activationEpoch === epoch) {
        this.activationEpoch += 1;
      }
      subscription.unsubscribe();
      this.resolvedDeps = null;
      this.latestInputs = null;
      this.lastSignedOut = null;
      this.lastEndpoint = null;
      this.inFlight.clear();
      this.backfillMisses.clear();
    };
  }

  requestResolve(actorLabels: readonly string[]): void {
    const endpoint = this.latestInputs?.authorProfilesEndpoint ?? null;
    const deps = this.resolvedDeps;
    if (!endpoint || !deps) {
      return;
    }

    const byPrincipal = new Map<string, string>();
    for (const actorLabel of actorLabels) {
      const principal = principalFromActorLabel(actorLabel);
      if (!principal) {
        continue;
      }
      const cached = this.snapshot.profiles.get(principal);
      // `profile` and `unresolved` mean the host answered; `backfillMisses`
      // covers presence/self-named principals the endpoint declined to upgrade.
      // Remaining presence/self seeds stay eligible so backfill can lift a
      // roster name to the durable profile name and avatar.
      if (cached?.source === "profile" || cached?.source === "unresolved") {
        continue;
      }
      if (this.backfillMisses.has(principal) || this.inFlight.has(principal)) {
        continue;
      }
      if (!byPrincipal.has(principal)) {
        byPrincipal.set(principal, actorLabel);
      }
    }
    if (byPrincipal.size === 0) {
      return;
    }

    const queued = Array.from(byPrincipal, ([principal, actorLabel]) => ({
      principal,
      actorLabel,
      token: Symbol(principal),
    }));
    for (const request of queued) {
      this.inFlight.set(request.principal, request.token);
    }

    void this.resolveQueuedProfiles(endpoint, queued, deps);
  }

  connectPresence(
    presenceStore: CloudViewerPresenceStore,
    getAuthSnapshot: () => CloudPrototypeAuthState,
  ): () => void {
    const seed = () => this.seedFromPresence(presenceStore.getSnapshot(), getAuthSnapshot());
    const unsubscribe = presenceStore.subscribe(seed);
    seed();
    return () => {
      unsubscribe();
    };
  }

  seedFromPresence(state: CloudViewerPresenceState, auth: CloudPrototypeAuthState): void {
    for (const peer of state.peers) {
      const principal = usablePrincipal(peer.participantKey);
      const displayName = usableLabel(peer.label);
      if (!principal || !displayName) {
        continue;
      }
      this.mergeProfile({
        principal,
        displayName,
        avatarUrl: null,
        source: "presence",
      });
    }

    const ownPrincipal = principalFromActorLabel(state.actorLabel);
    if (!ownPrincipal) {
      return;
    }
    const ownDisplayName = usableLabel(state.ownPeerLabel) ?? authDisplayName(auth);
    const ownAvatarUrl = authAvatarUrl(auth);
    if (!ownDisplayName && !ownAvatarUrl) {
      return;
    }
    this.mergeProfile({
      principal: ownPrincipal,
      displayName: ownDisplayName,
      avatarUrl: ownAvatarUrl,
      source: "self",
    });
  }

  resolve(actorLabel: string, source: "cloud" | "local" = "cloud"): ActorDisplay {
    const principal = principalFromActorLabel(actorLabel);
    const profile = principal ? this.snapshot.profiles.get(principal) : undefined;
    const peers: ActorDisplayPeer[] =
      profile && profile.displayName
        ? [
            {
              participantKey: profile.principal,
              label: profile.displayName,
              imageUrl: profile.avatarUrl,
            },
          ]
        : [];
    return resolveActorDisplay({ actorLabel, peers, source });
  }

  private async resolveQueuedProfiles(
    endpoint: string,
    queued: readonly {
      principal: string;
      actorLabel: string;
      token: symbol;
    }[],
    deps: ResolvedCloudUserStoreDeps,
  ): Promise<void> {
    for (let index = 0; index < queued.length; index += COMMENT_AUTHOR_PROFILE_LOOKUP_BATCH_SIZE) {
      const batch = queued.slice(index, index + COMMENT_AUTHOR_PROFILE_LOOKUP_BATCH_SIZE);
      await this.resolveProfileBatch(endpoint, batch, deps);
    }
  }

  private async resolveProfileBatch(
    endpoint: string,
    batch: readonly {
      principal: string;
      actorLabel: string;
      token: symbol;
    }[],
    deps: ResolvedCloudUserStoreDeps,
  ): Promise<void> {
    const issue = this.captureBackfillIssue(endpoint);
    const controller = new AbortController();
    try {
      const url = commentAuthorProfilesUrl(
        endpoint,
        batch.map((request) => request.actorLabel),
      );
      const response = await deps.fetchProfiles(url, controller.signal);
      if (!this.backfillStillCurrent(issue)) {
        return;
      }
      if (!response.ok) {
        return;
      }
      const parsed = parseProfilesResponse(await response.json());
      if (!this.backfillStillCurrent(issue)) {
        return;
      }
      this.applyBackfillBatch(batch, parsed);
    } catch {
      return;
    } finally {
      controller.abort();
      for (const request of batch) {
        if (this.inFlight.get(request.principal) === request.token) {
          this.inFlight.delete(request.principal);
        }
      }
    }
  }

  private applyBackfillBatch(
    batch: readonly {
      principal: string;
      actorLabel: string;
      token: symbol;
    }[],
    entries: readonly ParsedProfileEntry[],
  ): void {
    const requestedPrincipals = new Set(batch.map((request) => request.principal));
    const seenPrincipals = new Set<string>();
    for (const entry of entries) {
      if (!requestedPrincipals.has(entry.principal)) {
        continue;
      }
      seenPrincipals.add(entry.principal);
      if (!entry.resolved) {
        this.backfillMisses.add(entry.principal);
      }
      this.mergeProfile(profileFromEntry(entry));
    }

    for (const principal of requestedPrincipals) {
      if (seenPrincipals.has(principal)) {
        continue;
      }
      // The relationship gate omits principals it will not resolve; cache that
      // miss so repeated surfaces do not refetch the same denied principal.
      this.backfillMisses.add(principal);
      this.mergeProfile({
        principal,
        displayName: null,
        avatarUrl: null,
        source: "unresolved",
      });
    }
  }

  /** Route-swap cleanup: unresolved entries belong to the endpoint that said so. */
  private dropUnresolvedEntries(): void {
    const entries = Array.from(this.snapshot.profiles).filter(
      ([, profile]) => profile.source !== "unresolved",
    );
    if (entries.length === this.snapshot.profiles.size) {
      return;
    }
    this.setState({ profiles: new Map(entries) });
  }

  private captureBackfillIssue(endpoint: string): BackfillIssue {
    return { epoch: this.activationEpoch, endpoint };
  }

  private backfillStillCurrent(issue: BackfillIssue): boolean {
    // A backfill response belongs only to the endpoint and epoch it was issued under.
    return (
      this.activationEpoch === issue.epoch &&
      this.latestInputs?.authorProfilesEndpoint === issue.endpoint
    );
  }

  /**
   * Apply source precedence and the never-demote invariant from the ADR:
   * absence of a fresh answer is not evidence the name is gone. A higher-rank
   * source takes over the entry, but its null fields are backfilled from the
   * existing entry so a profile row with no avatar cannot erase the avatar a
   * self/presence seed already knew.
   */
  private mergeProfile(next: CloudResolvedProfile): void {
    const existing = this.snapshot.profiles.get(next.principal);
    if (existing) {
      if (next.source === "unresolved" || SOURCE_RANK[next.source] < SOURCE_RANK[existing.source]) {
        return;
      }
      next = {
        ...next,
        displayName: next.displayName ?? existing.displayName,
        avatarUrl: next.avatarUrl ?? existing.avatarUrl,
      };
      if (profileEquals(existing, next)) {
        return;
      }
    }
    const profiles = new Map(this.snapshot.profiles);
    profiles.set(next.principal, next);
    this.setState({ profiles });
  }

  private resolveDeps(deps: CloudUserStoreDeps): ResolvedCloudUserStoreDeps {
    return {
      fetchProfiles: deps.fetchProfiles ?? defaultFetchProfiles,
    };
  }
}

/**
 * The app-wide user directory store. Route controllers activate it; domain
 * hooks consume it through `useCloudStores()`.
 */
export const cloudUserStore = new CloudUserStore();
