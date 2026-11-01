import * as A from "@automerge/automerge";
import { decodeRecordFrame } from "@automerge/automerge-repo-subduction";
import { REJECTION, admitCommentChanges } from "../model/comment-authority.mjs";
import { signedIssuer } from "./actor-authorship.mjs";

/**
 * Native per-author enforcement for a Page's comments document.
 *
 * The policy's put hook (worker/policy.mjs) sees the requesting key, the
 * signing key and the tree of each incoming record, but not its bytes. The
 * storage bridge's byte store sees both: every record it saves is a frame
 * holding the signed envelope, whose issuer is the signing key, and the blob,
 * which is the Automerge change (a commit) or a bundle of changes (a
 * fragment). The bridge saves one mutation at a time, so a byte store that
 * checks each comments-document record before writing it is exactly the
 * serialized admission point model/comment-authority.mjs needs.
 *
 * `guard(store)` wraps a byte store. For a record in the comments tree it:
 *
 * - admits a record the host signed (a tool write or the migration) as is;
 * - otherwise looks up the signer's principal and Page role and runs the
 *   per-author check against the admission document, the comments document
 *   as of every record accepted so far;
 * - saves the record, then adopts the checked document as the new admission
 *   document.
 *
 * A refused record throws a refusal (`recordRefused: true`) before anything
 * is written. patch-record-refusal.mjs makes the bridge treat that as an
 * answer to one save, not a storage failure: the record is neither stored nor
 * delivered, the native engine keeps running, and every other connection
 * stays up. A refusal for a rule the signer broke also calls `onRefused`,
 * which blocks that key's comment writes and closes its connection. Nothing
 * on the save path awaits storage or a disconnect: the native engine is
 * waiting on this save.
 *
 * A change whose dependencies the host lacks, or one the checker can't read,
 * is refused without blocking the key: that isn't proof of a broken rule.
 * An unexpected error inside the check is refused the same way, so a checker
 * bug can't turn into an engine reset.
 *
 * Every other record, and every other tree, passes straight through.
 */

const RECORD_PATH = /^subduction-v1\/([0-9a-f]{64})\/(commits|fragments)\/([0-9a-f]{64})$/;

/** Codes that mean the signer authored a change the rules forbid. */
const BLOCKING = new Set(
  Object.values(REJECTION).filter(
    (code) =>
      ![
        REJECTION.MISSING_DEPENDENCIES,
        REJECTION.INVALID_PRINCIPAL,
        REJECTION.MALFORMED_CHANGE,
      ].includes(code),
  ),
);
export const ADMISSION_ERROR = "admission_error";

/** The tree, kind, signer and blob of a saved record, or null when `path`
 * isn't a record path. Decoded by the bridge's own record codec. A record
 * path whose frame doesn't decode, or disagrees with its path, throws. */
export function recordFrame(path, value, maxRecordBytes) {
  const match = typeof path === "string" ? RECORD_PATH.exec(path) : null;
  if (!match) return null;
  const frame = decodeRecordFrame(value, maxRecordBytes);
  const kind = match[2] === "commits" ? "commit" : "fragment";
  const issuer = signedIssuer(frame.signed);
  if (frame.tree !== match[1] || frame.kind !== kind || frame.key !== match[3] || !issuer)
    throw Error("Record frame disagrees with its path");
  return { tree: match[1], kind, issuer, blob: frame.blob };
}

/** A refused record. `recordRefused` is the marker the storage bridge reads
 * (patch-record-refusal.mjs). */
export class Refusal extends Error {
  constructor(reason) {
    super(`Comment change refused: ${reason.message}`);
    this.status = 403;
    this.code = "comment_change_refused";
    this.reason = reason;
    this.recordRefused = true;
  }
}

/** The encoded changes a record holds that `doc` lacks. A fragment's bundle
 * is applied to a scratch copy; every change it names must apply, or the
 * record depends on history this document doesn't hold. */
function recordChanges(doc, frame) {
  if (frame.kind === "commit") return [new Uint8Array(frame.blob)];
  let hashes, scratch;
  try {
    hashes = A.readBundle(frame.blob).changes.map((change) => change.hash);
    scratch = A.loadIncremental(A.clone(doc), frame.blob);
  } catch {
    if (scratch) A.free(scratch);
    throw new Refusal({ code: REJECTION.MALFORMED_CHANGE, message: "Bundle could not be read" });
  }
  try {
    if (!A.hasHeads(scratch, hashes))
      throw new Refusal({
        code: REJECTION.MISSING_DEPENDENCIES,
        message: "The bundle depends on changes this document lacks",
      });
    return A.getChanges(doc, scratch);
  } finally {
    A.free(scratch);
  }
}

/** Refusals one principal may cause in a window before its records are
 * refused unread and its connection closes. */
export const REFUSAL_BUDGET = 8;
export const REFUSAL_WINDOW_MS = 60_000;
/** How long an identical refused record is refused again without decoding,
 * while nothing new has been admitted. */
export const REFUSAL_CACHE_TTL_MS = 30_000;
const REFUSAL_CACHE_MAX = 512;
const BUDGET_MAX = 1024;
export const THROTTLED = "comment_admission_throttled";
export const CACHED = "comment_refusal_cached";

/**
 * One principal's refusal budget, as a pure step. `entry` is
 * `{ windowStart, count, throttledUntil }` or undefined.
 *
 * - `charge`: a record from the principal was refused. A window older than
 *   REFUSAL_WINDOW_MS starts over. Reaching REFUSAL_BUDGET throttles the
 *   principal for one window and reports `exceeded` once.
 * - Reading `throttled(entry, now)` says whether its records are refused
 *   unread. When the window passes it isn't, and a missing dependency that
 *   has since arrived is admitted normally.
 */
export function chargeRefusal(entry, now) {
  const fresh = !entry || now - entry.windowStart >= REFUSAL_WINDOW_MS;
  const count = fresh ? 1 : entry.count + 1;
  const windowStart = fresh ? now : entry.windowStart;
  const exceeded = count >= REFUSAL_BUDGET && !(entry?.throttledUntil > now);
  return {
    entry: {
      windowStart,
      count,
      throttledUntil: exceeded ? now + REFUSAL_WINDOW_MS : (entry?.throttledUntil ?? 0),
    },
    exceeded,
  };
}
export const throttled = (entry, now) => !!entry && entry.throttledUntil > now;

/** A refusal cache key for a stored v2 record: its path and its signed
 * envelope's digest, both read from the frame header without decoding. A
 * different signer of the same change has a different digest. */
export function refusalKey(path, value) {
  if (!(value instanceof Uint8Array) || value.length < 112 || value[0] !== 0x53) return undefined;
  let digest = "";
  for (let i = 80; i < 112; i++) digest += value[i].toString(16).padStart(2, "0");
  return `${path}#${digest}`;
}

export class CommentAdmission {
  /**
   * @param {object} options
   * @param {() => string | undefined} options.tree the comments tree, 64 hex
   * @param {string} options.serverKey the host's signing key
   * @param {(key: string) => { principal: string, role: string } | undefined} options.signer
   * @param {() => A.Doc<unknown> | undefined} options.seed the comments
   *   document as stored now, to start or rebuild the admission document
   * @param {(key: string, reason: object) => void} [options.onRefused] called,
   *   not awaited, when the signer broke a rule; it must not throw
   * @param {(key: string) => void} [options.onThrottled] called, not awaited,
   *   when a record's signer spends its principal's refusal budget, and for
   *   every record submitted while that principal is throttled; it must not
   *   throw. The caller closes that signer's connection retryably.
   * @param {number} [options.maxRecordBytes] the backend's record limit
   * @param {() => number} [options.now] the clock
   */
  constructor({
    tree,
    serverKey,
    signer,
    seed,
    onRefused = () => {},
    onThrottled = () => {},
    maxRecordBytes,
    now = Date.now,
  }) {
    this.maxRecordBytes = maxRecordBytes ?? 16 * 1024 * 1024;
    this.tree = tree;
    this.serverKey = serverKey;
    this.signer = signer;
    this.seed = seed;
    this.onRefused = onRefused;
    this.onThrottled = onThrottled;
    this.now = now;
    this.admitted = undefined;
    // Bumped whenever the admission document gains a change, so a cached
    // refusal (a missing dependency, say) is checked again after it.
    this.generation = 0;
    this.refusals = new Map();
    this.budgets = new Map();
    // Work counters: records decoded and checked, and refusals that skipped it.
    this.stats = { checked: 0, cached: 0, throttled: 0 };
  }

  /** Forget the admission document; the next check rebuilds it. */
  reset() {
    if (this.admitted) A.free(this.admitted);
    this.admitted = undefined;
    this.generation++;
  }

  current() {
    if (this.admitted) return this.admitted;
    const seed = this.seed();
    this.admitted = seed ? A.clone(seed) : A.init();
    return this.admitted;
  }

  /** Refuse without decoding when `key` was refused for the current
   * admission document within the TTL. */
  cachedRefusal(key) {
    if (!key) return undefined;
    const cached = this.refusals.get(key);
    if (!cached) return undefined;
    if (cached.generation !== this.generation || cached.expires <= this.now()) {
      this.refusals.delete(key);
      return undefined;
    }
    return cached;
  }

  /** Charge a refusal to the signer's principal. Bounded: the oldest
   * principals are forgotten first. */
  charge(principal) {
    const { entry, exceeded } = chargeRefusal(this.budgets.get(principal), this.now());
    this.budgets.delete(principal);
    this.budgets.set(principal, entry);
    if (this.budgets.size > BUDGET_MAX) this.budgets.delete(this.budgets.keys().next().value);
    return exceeded;
  }

  /** Remember a refused record for the TTL. */
  remember(key, code) {
    if (!key || code === THROTTLED || code === CACHED || code === ADMISSION_ERROR) return;
    this.refusals.delete(key);
    this.refusals.set(key, {
      code,
      generation: this.generation,
      expires: this.now() + REFUSAL_CACHE_TTL_MS,
    });
    if (this.refusals.size > REFUSAL_CACHE_MAX)
      this.refusals.delete(this.refusals.keys().next().value);
  }

  /** Check entries `[path, value]`; resolves with the checked document to
   * adopt after they're saved, or null when none is in the comments tree.
   * Throws a Refusal. A multi-record save is one causal group the bridge
   * couldn't order, so a record whose dependencies come later in the group
   * waits for them.
   *
   * A peer's record is refused before any decode or apply when the same
   * record was refused for the current admission document within the TTL,
   * or when its signer's principal is throttled. Every refusal of a peer's
   * record charges its principal's budget; spending it throttles the
   * principal for a window. The submitting connection closes, retryably,
   * for that record and for every record submitted while throttled.
   */
  check(entries) {
    const tree = this.tree()?.padEnd(64, "0");
    if (!tree) return null;
    const records = entries.filter(
      ([path]) => typeof path === "string" && path.includes(`/${tree}/`) && RECORD_PATH.test(path),
    );
    if (!records.length) return null;
    let current;
    try {
      const pending = [];
      for (const [path, value] of records) {
        const key = refusalKey(path, value);
        current = { key };
        const cached = this.cachedRefusal(key);
        if (cached) {
          this.stats.cached++;
          current.issuer = cached.issuer;
          current.principal = cached.principal;
          throw new Refusal({ code: CACHED, message: "This record was refused moments ago" });
        }
        let frame;
        try {
          frame = recordFrame(path, value, this.maxRecordBytes);
        } catch {
          throw new Refusal({
            code: REJECTION.MALFORMED_CHANGE,
            message: "Record frame is invalid",
          });
        }
        current = { key, issuer: frame.issuer };
        if (frame.issuer !== this.serverKey) {
          const signer = this.signer(frame.issuer);
          if (!signer)
            throw new Refusal({
              code: REJECTION.INVALID_PRINCIPAL,
              message: "Unknown signing key",
            });
          current.principal = signer.principal;
          if (throttled(this.budgets.get(signer.principal), this.now())) {
            this.stats.throttled++;
            throw new Refusal({
              code: THROTTLED,
              message: "Too many refused comment changes; try again shortly",
            });
          }
          frame.signer = signer;
        }
        frame.key = key;
        pending.push(frame);
      }
      return this.admitAll(pending, (frame) => {
        current = { key: frame.key, issuer: frame.issuer, principal: frame.signer?.principal };
      });
    } catch (error) {
      const refusal =
        error instanceof Refusal
          ? error
          : new Refusal({ code: ADMISSION_ERROR, message: "The change could not be checked" });
      if (!(error instanceof Refusal))
        // A checker bug refuses the record; it never resets the engine.
        console.error(
          JSON.stringify({
            service: "nteract-pages-native",
            event: "page.comment_admission_error",
            error: String(error?.message ?? error).slice(0, 200),
          }),
        );
      this.settleRefusal(refusal, current);
      throw refusal;
    }
  }

  /** Book a refusal: log it, cache it, and charge the signer's principal. */
  settleRefusal(refusal, frame) {
    const code = refusal.reason.code;
    // One line per refused record. A host-signed one should never be
    // refused; `host: true` here is a bug to chase.
    console.error(
      JSON.stringify({
        service: "nteract-pages-native",
        event: "page.comment_record_refused",
        code,
        host: !!frame?.issuer && frame.issuer === this.serverKey,
      }),
    );
    if (!frame || frame.issuer === this.serverKey) return;
    if (frame.key && frame.issuer && frame.principal && !this.refusals.has(frame.key))
      this.remember(frame.key, code);
    const cached = this.refusals.get(frame.key);
    if (cached) Object.assign(cached, { issuer: frame.issuer, principal: frame.principal });
    if (!frame.principal) return;
    // Every submission from a throttled principal closes its connection
    // retryably, not just the one that spent the budget: a reconnect or
    // another key of the same principal would otherwise stay open while its
    // comments are refused, with nothing telling it to back off.
    // That covers a refusal served from the cache too.
    if (code !== THROTTLED) this.charge(frame.principal);
    if (throttled(this.budgets.get(frame.principal), this.now())) this.onThrottled(frame.issuer);
  }

  /** Admit decoded frames in causal order onto a clone of the admission
   * document. `track(frame)` names the frame being checked. */
  admitAll(frames, track) {
    let pending = frames;
    const base = this.current();
    let doc = base;
    const replace = (next) => {
      if (doc !== base) A.free(doc);
      doc = next;
    };
    try {
      while (pending.length) {
        const waiting = [];
        let missing;
        for (const frame of pending) {
          track(frame);
          const reason = this.admitFrame(doc, frame, replace);
          if (reason) {
            missing = { reason, frame };
            waiting.push(frame);
          }
        }
        if (waiting.length === pending.length) {
          track(missing.frame);
          throw new Refusal(missing.reason);
        }
        pending = waiting;
      }
      return doc === base ? A.clone(base) : doc;
    } catch (error) {
      if (doc !== base) A.free(doc);
      throw error;
    }
  }

  /** Admit one record onto `doc` through `replace`. Returns the reason when
   * its dependencies aren't there yet; throws any other refusal. */
  admitFrame(doc, frame, replace) {
    this.stats.checked++;
    let changes;
    try {
      changes = recordChanges(doc, frame);
    } catch (error) {
      if (error instanceof Refusal && error.reason.code === REJECTION.MISSING_DEPENDENCIES)
        return error.reason;
      throw error;
    }
    if (frame.issuer === this.serverKey) {
      const [next] = A.applyChanges(A.clone(doc), changes);
      if (
        !A.hasHeads(
          next,
          changes.map((change) => A.decodeChange(change).hash),
        )
      ) {
        A.free(next);
        return {
          code: REJECTION.MISSING_DEPENDENCIES,
          message: "The record depends on changes this document lacks",
        };
      }
      replace(next);
      return null;
    }
    const { signer } = frame;
    const result = admitCommentChanges(doc, changes, signer.principal, { role: signer.role });
    if (!result.ok) {
      if (result.reason.code === REJECTION.MISSING_DEPENDENCIES) return result.reason;
      if (BLOCKING.has(result.reason.code)) this.onRefused(frame.issuer, result.reason);
      throw new Refusal(result.reason);
    }
    replace(result.next);
    return null;
  }

  adopt(next) {
    if (!next) return;
    if (this.admitted && this.admitted !== next) {
      if (A.getHeads(this.admitted).join() !== A.getHeads(next).join()) this.generation++;
      A.free(this.admitted);
    }
    this.admitted = next;
  }

  /** A byte store whose saves check comments-document records first. */
  guard(store) {
    const write = async (entries, save) => {
      const next = this.check(entries);
      try {
        await save();
      } catch (error) {
        // An ambiguous failure may have landed: rebuild from storage next.
        if (next) A.free(next);
        if (next) this.reset();
        throw error;
      }
      this.adopt(next);
    };
    return new Proxy(store, {
      get: (target, property) => {
        if (property === "save")
          return (key, value) => write([[key, value]], () => target.save(key, value));
        if (property === "saveMany" && typeof target.saveMany === "function")
          return (entries) => write(entries, () => target.saveMany(entries));
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
}
