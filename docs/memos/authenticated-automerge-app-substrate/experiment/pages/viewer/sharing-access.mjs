import { request } from "./request.mjs";
import { monotonicNow } from "./monotonic.mjs";

export const SHARING_FRESH_MS = 30_000;
// A missing company-email proof refuses one sharing change; it is not a loss of
// Page access, so the owner's ledger stays and is reloaded with the new proof state.
export const COMPANY_PROOF_REQUIRED = "company_email_proof_required";
const accessError = (error) =>
  [401, 403, 404].includes(error?.status) && error?.code !== COMPANY_PROOF_REQUIRED;

export function sharingAvailable(session) {
  return (
    session.alive !== false &&
    !!session.identity?.principal &&
    !!session.access?.canRead &&
    !session.authRequired &&
    !session.accessDenied &&
    !session.accessReloadRequired &&
    session.localPage?.registered !== false
  );
}

// One resource per mounted Page session, never a global or persisted ACL cache.
// Closing its popover does not discard verified access or interrupt a mutation.
export function createSharingAccess(
  session,
  { request: send = request, now = monotonicNow, freshMs = SHARING_FRESH_MS } = {},
) {
  const { pageId } = session,
    principal = session.identity?.principal,
    endpoint = `/api/access?page=${encodeURIComponent(pageId)}`,
    listeners = new Set();
  let snapshot = { value: null, error: null, refreshing: false, busy: null },
    updatedAt = -Infinity,
    pending = null,
    generation = 0,
    disposed = false;
  const current = () =>
    !disposed &&
    session.pageId === pageId &&
    session.identity?.principal === principal &&
    sharingAvailable(session);
  function publish(patch) {
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) listener();
  }
  function invalidate() {
    generation++;
    pending?.controller.abort();
    pending = null;
    updatedAt = -Infinity;
    publish({ value: null, error: null, refreshing: false, busy: null });
  }
  function operation(options, { busy = null, preserveError = false } = {}) {
    const revision = ++generation,
      controller = new AbortController(),
      previousError = preserveError ? snapshot.error : null;
    publish({ refreshing: !busy, busy, error: previousError });
    const work = Promise.resolve()
      .then(() => send(endpoint, { ...options, signal: controller.signal }))
      .then((value) => {
        if (!current() || revision !== generation) return null;
        // Owner ledgers are private. A cookie/account change must not install
        // another account's owner response into this session's cache.
        if (value?.access?.canManageAccess && value.owner?.principal !== principal)
          throw Object.assign(Error("Sign in with this Page's original account."), { status: 401 });
        if (value?.access?.canManageAccess && !session.canManageAccess) {
          invalidate();
          return null;
        }
        updatedAt = now();
        publish({ value, error: previousError });
        return value;
      })
      .catch((error) => {
        if (!current() || revision !== generation) return null;
        updatedAt = -Infinity;
        publish({ error, ...(accessError(error) ? { value: null } : {}) });
        throw error;
      })
      .finally(() => {
        if (revision !== generation) return;
        pending = null;
        if (!current()) invalidate();
        else publish({ refreshing: false, busy: null });
      });
    pending = { controller, work };
    return work;
  }
  function read({ force = false, preserveError = false } = {}) {
    if (!current()) {
      invalidate();
      return Promise.resolve(null);
    }
    if (pending) return pending.work;
    if (!force && snapshot.value && !snapshot.error && now() - updatedAt < freshMs)
      return Promise.resolve(snapshot.value);
    return operation({}, { preserveError });
  }
  async function mutate(action, key) {
    if (!current() || !session.canManageAccess || !snapshot.value?.access?.canManageAccess)
      return null;
    if (snapshot.busy) return null;
    // A GET begun before this write must not overwrite its newer response.
    pending?.controller.abort();
    pending = null;
    updatedAt = -Infinity;
    try {
      return await operation(
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...action,
            expected_revision: snapshot.value.access.revision,
            idempotency_key: crypto.randomUUID(),
          }),
        },
        { busy: key },
      );
    } catch (error) {
      if (error.status === 409 && current())
        await read({ force: true, preserveError: true }).catch(() => {});
      // The reloaded ledger carries domainProof, which explains the refusal.
      else if (error.code === COMPANY_PROOF_REQUIRED && current())
        await read({ force: true }).catch(() => {});
      throw error;
    }
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    read,
    mutate,
    invalidate,
    activate() {
      disposed = false;
    },
    dispose() {
      disposed = true;
      invalidate();
      listeners.clear();
    },
  };
}
