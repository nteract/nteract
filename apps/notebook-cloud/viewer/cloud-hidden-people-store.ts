import {
  BehaviorSubject,
  EMPTY,
  Subject,
  catchError,
  combineLatest,
  defer,
  distinctUntilChanged,
  from,
  map,
  takeUntil,
  type Observable,
} from "rxjs";
import { fetchLatest, ObservableStore } from "runtimed";
import { peopleSearchAuthKey } from "./cloud-people-search-store";
import type { CloudPrototypeAuthState } from "./collaborator-auth";
import type {
  CloudCollaboratorPerson,
  CloudHiddenPeopleState,
  CloudHiddenPerson,
} from "./people-search-types";

export const EMPTY_HIDDEN_PEOPLE: CloudHiddenPeopleState = {
  authKey: null,
  hidden: [],
  nextCursor: null,
  status: "idle",
  busyId: null,
  error: null,
  lastHidden: null,
};
interface Inputs {
  auth: CloudPrototypeAuthState;
  open: boolean;
}
interface Deps {
  request: (url: string, init: RequestInit) => Promise<Response>;
  beginMutation: () => symbol;
  endMutation: (token: symbol) => void;
}

const INPUT_FIELDS = { auth: true, open: true } satisfies Record<keyof Inputs, true>;
function inputsEqual(a: Inputs, b: Inputs): boolean {
  void INPUT_FIELDS;
  return a.open === b.open && peopleSearchAuthKey(a.auth) === peopleSearchAuthKey(b.auth);
}

function parseHidden(body: unknown): { hidden: CloudHiddenPerson[]; nextCursor: string | null } {
  if (!body || typeof body !== "object") throw new Error("Invalid hidden suggestions response");
  const result = body as { hidden?: unknown; nextCursor?: unknown };
  if (
    !Array.isArray(result.hidden) ||
    !(result.nextCursor === null || typeof result.nextCursor === "string")
  ) {
    throw new Error("Invalid hidden suggestions response");
  }
  return {
    nextCursor: result.nextCursor,
    hidden: result.hidden.slice(0, 20).flatMap((entry: unknown) => {
      if (!entry || typeof entry !== "object") return [];
      const person = entry as Partial<CloudHiddenPerson>;
      return typeof person.id === "string" &&
        typeof person.personId === "string" &&
        typeof person.displayName === "string" &&
        (person.avatarUrl === null || typeof person.avatarUrl === "string")
        ? [
            {
              id: person.id,
              personId: person.personId,
              displayName: person.displayName,
              avatarUrl: person.avatarUrl,
            },
          ]
        : [];
    }),
  };
}

/** Only one bounded page of the caller's suppressions; never an all-people directory. */
export class CloudHiddenPeopleStore extends ObservableStore<CloudHiddenPeopleState> {
  private authKey: string | null = null;
  private epoch = 0;
  private inputs: Inputs | null = null;
  private deps: Deps | null = null;
  private mutation: AbortController | null = null;
  private readonly listCancelled$ = new Subject<void>();
  private readonly page$ = new BehaviorSubject<{
    cursor: string | null;
    revision: number;
    preserveError: boolean;
  }>({
    cursor: null,
    revision: 0,
    preserveError: false,
  });

  constructor() {
    super(EMPTY_HIDDEN_PEOPLE);
  }

  syncAuth(auth: CloudPrototypeAuthState): void {
    const key = peopleSearchAuthKey(auth);
    if (this.authKey === key) return;
    this.authKey = key;
    this.epoch += 1;
    this.listCancelled$.next();
    this.mutation?.abort();
    this.mutation = null;
    this.resetState(EMPTY_HIDDEN_PEOPLE);
  }

  activate(inputs$: Observable<Inputs>, deps: Deps): () => void {
    this.deps = deps;
    const subscription = fetchLatest(
      combineLatest([inputs$.pipe(distinctUntilChanged(inputsEqual)), this.page$]).pipe(
        map(([input, page]) => ({ input, page })),
      ),
      ({ input, page }, signal) => {
        const changedAccount =
          !this.inputs || peopleSearchAuthKey(this.inputs.auth) !== peopleSearchAuthKey(input.auth);
        const newlyOpened = input.open && !this.inputs?.open;
        this.syncAuth(input.auth);
        this.inputs = input;
        const key = this.authKey;
        const epoch = this.epoch;
        const current = () => !signal.aborted && this.epoch === epoch && this.authKey === key;
        if (!input.open || input.auth.mode === "anonymous" || input.auth.mode === "invalid") {
          this.setState({
            ...EMPTY_HIDDEN_PEOPLE,
            authKey: key,
            lastHidden: this.snapshot.lastHidden,
            busyId: this.snapshot.busyId,
          });
          return EMPTY;
        }
        if (this.mutation) return EMPTY;
        const cursor = changedAccount || newlyOpened ? null : page.cursor;
        this.setState({
          ...this.snapshot,
          authKey: key,
          hidden: [],
          nextCursor: null,
          status: "loading",
          // The temporary confirmation may contain a name the server now
          // redacts. Once the list opens, its fresh rows own profile display.
          lastHidden: null,
          error: page.preserveError ? this.snapshot.error : null,
        });
        return defer(() =>
          from(
            (async () => {
              const response = await deps.request(
                `/api/people/hidden${cursor ? `?after=${encodeURIComponent(cursor)}` : ""}`,
                { signal },
              );
              if (!current()) return;
              if (!response.ok) throw new Error("Unable to load hidden suggestions.");
              const body: unknown = await response.json();
              if (!current()) return;
              this.setState({
                ...this.snapshot,
                ...parseHidden(body),
                authKey: key,
                status: "ready",
              });
            })(),
          ),
        ).pipe(
          catchError(() => {
            if (current())
              this.setState({
                ...this.snapshot,
                hidden: [],
                nextCursor: null,
                status: "error",
                error: "Unable to load hidden suggestions.",
              });
            return EMPTY;
          }),
          takeUntil(this.listCancelled$),
        );
      },
    ).subscribe();
    return () => {
      subscription.unsubscribe();
      this.epoch += 1;
      this.mutation?.abort();
      this.mutation = null;
      this.deps = null;
      this.inputs = null;
      this.resetState(EMPTY_HIDDEN_PEOPLE);
    };
  }

  loadPage(cursor: string | null = null): void {
    this.refreshPage(cursor, false);
  }

  private refreshPage(cursor: string | null, preserveError: boolean): void {
    this.page$.next({ cursor, preserveError, revision: this.page$.value.revision + 1 });
  }

  hide(person: CloudCollaboratorPerson): Promise<void> {
    return this.mutate("hide", person.id, person);
  }

  undo(hiddenId: string): Promise<void> {
    return this.mutate("undo", hiddenId);
  }

  private async mutate(
    action: "hide" | "undo",
    id: string,
    person?: CloudCollaboratorPerson,
  ): Promise<void> {
    const deps = this.deps;
    const input = this.inputs;
    if (
      !deps ||
      !input ||
      this.mutation ||
      peopleSearchAuthKey(input.auth) !== this.authKey ||
      input.auth.mode === "anonymous" ||
      input.auth.mode === "invalid"
    )
      return;
    this.epoch += 1;
    this.listCancelled$.next();
    const key = this.authKey;
    const epoch = this.epoch;
    const controller = new AbortController();
    this.mutation = controller;
    const token = deps.beginMutation();
    const current = () =>
      !controller.signal.aborted && this.epoch === epoch && this.authKey === key;
    this.setState({
      ...this.snapshot,
      authKey: key,
      hidden: [],
      nextCursor: null,
      busyId: id,
      error: null,
    });
    try {
      const response = await deps.request(
        action === "hide" ? "/api/people/hidden" : `/api/people/hidden/${encodeURIComponent(id)}`,
        {
          method: action === "hide" ? "POST" : "DELETE",
          headers: { "Content-Type": "application/json" },
          ...(action === "hide" ? { body: JSON.stringify({ personId: id }) } : {}),
          signal: controller.signal,
        },
      );
      if (!current()) return;
      if (!response.ok) throw new Error("Unable to change this suggestion. Try again.");
      if (action === "hide" && person) {
        const body: unknown = await response.json();
        if (!current()) return;
        if (!body || typeof body !== "object" || !("id" in body) || typeof body.id !== "string")
          throw new Error("Invalid suppression response");
        this.setState({
          ...this.snapshot,
          lastHidden: {
            id: body.id,
            personId: person.id,
            displayName: person.displayName,
            avatarUrl: person.avatarUrl,
          },
        });
      } else {
        this.setState({
          ...this.snapshot,
          hidden: this.snapshot.hidden.filter((entry) => entry.id !== id),
          lastHidden: this.snapshot.lastHidden?.id === id ? null : this.snapshot.lastHidden,
        });
      }
    } catch {
      if (current())
        this.setState({ ...this.snapshot, error: "Unable to change this suggestion. Try again." });
    } finally {
      if (this.mutation === controller) {
        this.mutation = null;
        if (current()) this.setState({ ...this.snapshot, busyId: null });
        if (current() && this.inputs?.open) this.refreshPage(null, true);
      }
      deps.endMutation(token);
    }
  }
}
