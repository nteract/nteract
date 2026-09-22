import {
  EMPTY,
  BehaviorSubject,
  Subject,
  catchError,
  combineLatest,
  defer,
  distinctUntilChanged,
  from,
  map,
  of,
  switchMap,
  takeUntil,
  timer,
  type Observable,
  type SchedulerLike,
} from "rxjs";
import { fetchLatest, ObservableStore, stableCacheKey } from "runtimed";
import type { CloudPrototypeAuthState } from "./collaborator-auth";
import type { CloudPeopleSearchResult, CloudPeopleSearchState } from "./people-search-types";

function searchEnabled(result: CloudPeopleSearchResult | undefined): boolean {
  return result?.directoryEnabled === true || result?.collaboratorsEnabled === true;
}

export interface CloudPeopleSearchInputs {
  auth: CloudPrototypeAuthState;
  open: boolean;
  query: string;
}

export interface CloudPeopleSearchDeps {
  fetchPeople: (url: string, signal: AbortSignal) => Promise<Response>;
  scheduler?: SchedulerLike;
  now?: () => number;
}

export const EMPTY_PEOPLE_SEARCH: CloudPeopleSearchState = {
  authKey: null,
  query: "",
  status: "idle",
  directoryEnabled: false,
  people: [],
};

const CACHE_TTL_MS = 60_000;
const CACHE_LIMIT = 20;

export function peopleSearchAuthKey(auth: CloudPrototypeAuthState): string {
  return stableCacheKey([
    auth.mode,
    auth.token,
    auth.user,
    auth.requestedScope,
    auth.oidcClaims?.sub,
    auth.oidcClaims?.email,
    auth.oidcClaims?.email_verified,
  ]);
}

export function normalizePeopleQuery(query: string): string {
  const trimmed = query.trim().toLowerCase();
  // Full-email invitations do not need a directory lookup.
  return trimmed.includes("@") || trimmed.length < 2 ? "" : trimmed;
}

const INPUT_FIELDS = { auth: true, open: true, query: true } satisfies Record<
  keyof CloudPeopleSearchInputs,
  true
>;

function inputsEqual(a: CloudPeopleSearchInputs, b: CloudPeopleSearchInputs): boolean {
  void INPUT_FIELDS;
  return (
    a.open === b.open &&
    normalizePeopleQuery(a.query) === normalizePeopleQuery(b.query) &&
    peopleSearchAuthKey(a.auth) === peopleSearchAuthKey(b.auth)
  );
}

function parseResult(body: unknown): CloudPeopleSearchResult {
  if (!body || typeof body !== "object" || !("directoryEnabled" in body)) {
    throw new Error("Invalid people response");
  }
  const result = body as Partial<CloudPeopleSearchResult>;
  if (typeof result.directoryEnabled !== "boolean" || !Array.isArray(result.people)) {
    throw new Error("Invalid people response");
  }
  return {
    directoryEnabled: result.directoryEnabled,
    collaboratorsEnabled: result.collaboratorsEnabled === true,
    ...(!result.directoryEnabled && result.requiresReverification === true
      ? { requiresReverification: true }
      : {}),
    people: searchEnabled(result as CloudPeopleSearchResult)
      ? result.people.slice(0, 10).flatMap((person) =>
          person &&
          typeof person.id === "string" &&
          typeof person.displayName === "string" &&
          ((person.source === "directory" && result.directoryEnabled) ||
            (person.source === "collaborator" && result.collaboratorsEnabled === true)) &&
          (person.avatarUrl === null || typeof person.avatarUrl === "string")
            ? [
                {
                  id: person.id,
                  displayName: person.displayName,
                  avatarUrl: person.avatarUrl,
                  source: person.source,
                },
              ]
            : [],
        )
      : [],
  };
}

/** Session-only bounded search cache, owned by CloudUserStore, never a full roster. */
export class CloudPeopleSearchStore extends ObservableStore<CloudPeopleSearchState> {
  private authKey: string | null = null;
  private epoch = 0;
  private readonly invalidated$ = new Subject<void>();
  private readonly refresh$ = new BehaviorSubject(0);
  private readonly mutations = new Set<symbol>();
  private capabilities: CloudPeopleSearchResult | undefined;
  private readonly cache = new Map<string, { at: number; result: CloudPeopleSearchResult }>();

  constructor() {
    super(EMPTY_PEOPLE_SEARCH);
  }

  syncAuth(auth: CloudPrototypeAuthState): void {
    const key = peopleSearchAuthKey(auth);
    if (this.authKey === key) return;
    this.authKey = key;
    this.epoch += 1;
    this.invalidated$.next();
    this.cache.clear();
    this.capabilities = undefined;
    this.mutations.clear();
    this.resetState(EMPTY_PEOPLE_SEARCH);
  }

  /** Freeze results while hide/undo is in flight so an older search cannot restore a row. */
  beginMutation(): symbol {
    const token = Symbol("people mutation");
    this.mutations.add(token);
    this.invalidate();
    return token;
  }

  endMutation(token: symbol): void {
    if (this.mutations.delete(token)) this.invalidate();
  }

  private invalidate(): void {
    this.epoch += 1;
    this.invalidated$.next();
    this.cache.clear();
    this.setState({ ...this.snapshot, people: [], status: "idle" });
    this.refresh$.next(this.refresh$.value + 1);
  }

  activate(inputs$: Observable<CloudPeopleSearchInputs>, deps: CloudPeopleSearchDeps): () => void {
    const now = deps.now ?? Date.now;
    const subscription = fetchLatest(
      combineLatest([inputs$.pipe(distinctUntilChanged(inputsEqual)), this.refresh$]).pipe(
        map(([input]) => input),
      ),
      (input, signal) => {
        this.syncAuth(input.auth);
        const authKey = peopleSearchAuthKey(input.auth);
        const epoch = this.epoch;
        const query = normalizePeopleQuery(input.query);
        if (!input.open || input.auth.mode === "anonymous" || input.auth.mode === "invalid") {
          this.resetState(EMPTY_PEOPLE_SEARCH);
          return EMPTY;
        }
        if (this.mutations.size > 0) return EMPTY;
        const current = () => !signal.aborted && epoch === this.epoch && authKey === this.authKey;
        const cached = (key: string) => {
          const entry = this.cache.get(key);
          return entry && now() - entry.at < CACHE_TTL_MS ? entry.result : undefined;
        };
        const known = this.capabilities;
        const hit = known && !searchEnabled(known) ? known : cached(query);
        if (hit) {
          this.setState({ ...hit, authKey, query, status: "ready" });
          return EMPTY;
        }
        this.setState({
          authKey,
          query,
          status: "loading",
          directoryEnabled: known?.directoryEnabled ?? false,
          collaboratorsEnabled: known?.collaboratorsEnabled ?? false,
          requiresReverification: known?.requiresReverification,
          people: [],
        });
        const fetchQuery = async (search: string): Promise<CloudPeopleSearchResult | null> => {
          const response = await deps.fetchPeople(
            `/api/people?q=${encodeURIComponent(search)}`,
            signal,
          );
          if (!current()) return null;
          if (!response.ok) throw new Error("People search unavailable");
          const body: unknown = await response.json();
          if (!current()) return null;
          const result = parseResult(body);
          this.capabilities = { ...result, people: [] };
          if (!searchEnabled(result)) {
            this.cache.clear();
            this.cache.set("", { at: now(), result });
          }
          this.cache.delete(search);
          this.cache.set(search, { at: now(), result });
          if (this.cache.size > CACHE_LIMIT) {
            const oldestQuery = Array.from(this.cache.keys()).find((key) => key !== "");
            if (oldestQuery !== undefined) this.cache.delete(oldestQuery);
          }
          return result;
        };
        return (query ? timer(250, deps.scheduler) : of(0)).pipe(
          switchMap(() =>
            defer(() =>
              from(
                (async () => {
                  const initial = known ? null : await fetchQuery("");
                  const eligibility = known ?? initial;
                  if (!current() || !eligibility) return;
                  const result =
                    searchEnabled(eligibility) && query && query.length <= 80
                      ? await fetchQuery(query)
                      : !query && eligibility.collaboratorsEnabled
                        ? (initial ?? (await fetchQuery("")))
                        : { ...eligibility, people: [] };
                  if (!current() || !result) return;
                  this.setState({ ...result, authKey, query, status: "ready" });
                })(),
              ),
            ),
          ),
          catchError(() => {
            if (current()) {
              this.cache.clear();
              this.capabilities = undefined;
              this.setState({
                authKey,
                query,
                status: "error",
                directoryEnabled: known?.directoryEnabled ?? false,
                collaboratorsEnabled: known?.collaboratorsEnabled ?? false,
                people: [],
              });
            }
            return EMPTY;
          }),
          takeUntil(this.invalidated$),
        );
      },
    ).subscribe();
    return () => {
      subscription.unsubscribe();
      this.resetState(EMPTY_PEOPLE_SEARCH);
    };
  }
}
