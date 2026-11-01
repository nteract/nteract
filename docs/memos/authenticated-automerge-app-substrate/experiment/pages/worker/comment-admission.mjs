import * as A from "@automerge/automerge";
import { REJECTION, admitCommentChanges } from "../model/comment-authority.mjs";

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
 * A refused record throws before it is written. The bridge then neither
 * stores nor delivers it, so the serving document never sees it. The bridge
 * treats any failed save as a storage failure and restarts its native engine,
 * which drops every connection; peers reconnect at once. So the refusal also
 * blocks the signing key from authoring comments again (`onRefused`): on
 * reconnect the policy refuses that key's comment records cleanly, without
 * another restart. An honest viewer never writes a refused change, because
 * the viewer and the tools apply the same rules first (comment-rules.mjs).
 *
 * A change whose dependencies the host lacks is refused without blocking the
 * key: the admission document trails storage only after a failed save, and
 * that is not the peer's fault.
 *
 * Every other record, and every other tree, passes straight through.
 */

const FRAME_MAGIC = [0x53, 0x44, 0x52, 0x02];
const FRAME_HEADER_BYTES = 112;
const SIGNED_MAGIC = [0x53, 0x54, 0x43, 0x00];
const RECORD_PATH = /^subduction-v1\/([0-9a-f]{64})\/(commits|fragments)\/([0-9a-f]{64})$/;
const hex = (value) => Array.from(value, (b) => b.toString(16).padStart(2, "0")).join("");

/** Codes that mean the peer authored a change the rules forbid. */
const BLOCKING = new Set(
  Object.values(REJECTION).filter(
    (code) => ![REJECTION.MISSING_DEPENDENCIES, REJECTION.INVALID_PRINCIPAL].includes(code),
  ),
);

/** The tree, kind, signer and blob of a saved record frame, or null. */
export function recordFrame(path, value) {
  const match = typeof path === "string" ? RECORD_PATH.exec(path) : null;
  if (!match || !(value instanceof Uint8Array) || value.length < FRAME_HEADER_BYTES) return null;
  if (!FRAME_MAGIC.every((byte, i) => value[i] === byte)) return null;
  if (![0, 1].includes(value[4]) || value[5] || value[6] || value[7]) return null;
  const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
  const signedLength = view.getUint32(8),
    blobLength = view.getUint32(12);
  if (FRAME_HEADER_BYTES + signedLength + blobLength !== value.length) return null;
  const signed = value.subarray(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + signedLength);
  if (signed.length < 36 || !SIGNED_MAGIC.every((byte, i) => signed[i] === byte)) return null;
  return {
    tree: match[1],
    kind: value[4] === 0 ? "commit" : "fragment",
    issuer: hex(signed.subarray(4, 36)),
    blob: value.subarray(FRAME_HEADER_BYTES + signedLength),
  };
}

class Refusal extends Error {
  constructor(reason) {
    super(`Comment change refused: ${reason.message}`);
    this.status = 403;
    this.code = "comment_change_refused";
    this.reason = reason;
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

export class CommentAdmission {
  /**
   * @param {object} options
   * @param {() => string | undefined} options.tree the comments tree, 64 hex
   * @param {string} options.serverKey the host's signing key
   * @param {(key: string) => { principal: string, role: string } | undefined} options.signer
   * @param {() => A.Doc<unknown> | undefined} options.seed the comments
   *   document as stored now, to start or rebuild the admission document
   * @param {(key: string, reason: object) => Promise<void>} [options.onRefused]
   */
  constructor({ tree, serverKey, signer, seed, onRefused = async () => {} }) {
    this.tree = tree;
    this.serverKey = serverKey;
    this.signer = signer;
    this.seed = seed;
    this.onRefused = onRefused;
    this.admitted = undefined;
  }

  /** Forget the admission document; the next check rebuilds it. */
  reset() {
    if (this.admitted) A.free(this.admitted);
    this.admitted = undefined;
  }

  current() {
    if (this.admitted) return this.admitted;
    const seed = this.seed();
    this.admitted = seed ? A.clone(seed) : A.init();
    return this.admitted;
  }

  /** Check entries `[path, value]`; resolves with the checked document to
   * adopt after they're saved, or null when none is in the comments tree.
   * Throws a Refusal. A multi-record save is one causal group the bridge
   * couldn't order, so a record whose dependencies come later in the group
   * waits for them. */
  async check(entries) {
    const tree = this.tree()?.padEnd(64, "0");
    if (!tree) return null;
    let pending = entries
      .map(([path, value]) => recordFrame(path, value))
      .filter((frame) => frame?.tree === tree);
    if (!pending.length) return null;
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
          const reason = await this.admitFrame(doc, frame, replace);
          if (reason) {
            missing = reason;
            waiting.push(frame);
          }
        }
        if (waiting.length === pending.length) throw new Refusal(missing);
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
  async admitFrame(doc, frame, replace) {
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
    const signer = this.signer(frame.issuer);
    if (!signer)
      throw new Refusal({ code: REJECTION.INVALID_PRINCIPAL, message: "Unknown signing key" });
    const result = admitCommentChanges(doc, changes, signer.principal, { role: signer.role });
    if (!result.ok) {
      if (result.reason.code === REJECTION.MISSING_DEPENDENCIES) return result.reason;
      if (BLOCKING.has(result.reason.code)) await this.onRefused(frame.issuer, result.reason);
      throw new Refusal(result.reason);
    }
    replace(result.next);
    return null;
  }

  adopt(next) {
    if (!next) return;
    if (this.admitted && this.admitted !== next) A.free(this.admitted);
    this.admitted = next;
  }

  /** A byte store whose saves check comments-document records first. */
  guard(store) {
    const write = async (entries, save) => {
      const next = await this.check(entries);
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
