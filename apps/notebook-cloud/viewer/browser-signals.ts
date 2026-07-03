/**
 * Shared browser event sources for the cloud viewer's RxJS stores.
 *
 * Each export is a lazily-started module singleton: one `addEventListener` per
 * signal, multicast to every store driver instead of the duplicated
 * focus/visibility/storage listener sets each hook wires by hand. `shareReplay`
 * with `refCount: false` keeps the underlying listener attached for the app's
 * lifetime, so a driver subscribing or unsubscribing never adds or removes a
 * DOM listener.
 *
 * SSR-safe: the `typeof window === "undefined"` guard is evaluated per
 * subscription (inside `defer`), so a module imported during server render and
 * reused after hydration still wires real listeners once `window` exists. Under
 * SSR each source is an empty, no-op observable.
 */

import {
  EMPTY,
  defer,
  distinctUntilChanged,
  filter,
  fromEvent,
  map,
  share,
  shareReplay,
  startWith,
  type Observable,
} from "rxjs";
import { isCloudPrototypeAuthStorageKey } from "./collaborator-auth";

/** SSR guard: no `window` means no DOM events, so the source is a no-op. */
function windowGuarded<T>(source: () => Observable<T>): Observable<T> {
  return defer<Observable<T>>(() => (typeof window === "undefined" ? EMPTY : source()));
}

/**
 * A seeded state source: one shared listener kept alive for the app's lifetime,
 * replaying the current value to late subscribers so they receive it
 * synchronously on subscribe.
 */
function seededSignal<T>(source: () => Observable<T>): Observable<T> {
  return windowGuarded(source).pipe(shareReplay({ bufferSize: 1, refCount: false }));
}

/**
 * A transient trigger source: one shared listener kept alive for the app's
 * lifetime, with no replay, so a late subscriber sees only future events and
 * never a stale one.
 */
function triggerSignal<T>(source: () => Observable<T>): Observable<T> {
  return windowGuarded(source).pipe(
    share({
      resetOnRefCountZero: false,
      resetOnComplete: false,
      resetOnError: false,
    }),
  );
}

/**
 * `true` while the document is visible. Seeded from `document.visibilityState`
 * and emits that seed synchronously on subscribe, satisfying `createPoll`'s
 * `active$` contract; subsequent `visibilitychange` events flip it, deduped by
 * `distinctUntilChanged`.
 */
export const documentVisible$: Observable<boolean> = seededSignal(() =>
  fromEvent(document, "visibilitychange").pipe(
    map(() => document.visibilityState === "visible"),
    startWith(document.visibilityState === "visible"),
    distinctUntilChanged(),
  ),
);

/** Fires once each time the window regains focus. */
export const windowFocus$: Observable<void> = triggerSignal(() =>
  fromEvent(window, "focus").pipe(map(() => undefined)),
);

/**
 * `storage` events that touch a cloud prototype auth key, pre-filtered so
 * subscribers react only to cross-tab auth mutations. Mirrors the
 * `use-cloud-auth.ts` handler: ignore writes to a foreign `storageArea`, then
 * keep only keys `isCloudPrototypeAuthStorageKey` recognizes (a `null` key is a
 * `storage.clear()`, which counts).
 */
export const cloudAuthStorage$: Observable<StorageEvent> = triggerSignal(() =>
  fromEvent<StorageEvent>(window, "storage").pipe(
    filter((event) => {
      if (event.storageArea && event.storageArea !== window.localStorage) {
        return false;
      }
      return isCloudPrototypeAuthStorageKey(event.key);
    }),
  ),
);
