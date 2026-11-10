import * as A from "@automerge/automerge";
import {
  createProgressTargets,
  resolveProgressTargets,
  validatePeerSelection,
  resolvePeerSelection,
} from "../model/presence.mjs";
import { HttpError } from "./auth.mjs";
import { AGENT_PRESENCE, expiry, idleAt, transition } from "../model/agent-presence.mjs";

export const ACTIVITY_LIMITS = Object.freeze({
  ttl: 60_000,
  selectionTtl: 30_000,
  perPrincipal: 4,
  progress: 16,
  peers: 24,
  snapshotBytes: 48 * 1024,
  readBytes: 128 * 1024,
});
const iso = (time) => new Date(time).toISOString();
const identityView = ({ principal, displayName, driver }) => ({ principal, displayName, driver });
const publicProgress = ({ progress_id, identity, message, targets, updatedAt, expiresAt }) => ({
  progress_id,
  ...identityView(identity),
  agent: identity.agent ?? null,
  session: identity.session ?? null,
  message,
  targets,
  updated_at: iso(updatedAt),
  expires_at: iso(expiresAt),
});
const byteSize = (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
// A record's time-based transitions travel with it: `idle_at` is when an
// active caret fades (null for a reading marker) and `expires_at` when the
// entry disappears. Readers apply them on their own clocks, so the host runs
// no timer to announce them.
const publicAgent = ({ agent_id, identity, record }) => {
  const fades = idleAt(record);
  return {
    agent_id,
    principal: identity.principal,
    displayName: identity.displayName,
    driver: identity.driver,
    agent: identity.agent ?? null,
    session: identity.session ?? null,
    state: record.state,
    seq: record.seq,
    targets: record.targets,
    updated_at: iso(record.lastCall),
    idle_at: fades === null ? null : iso(fades),
    expires_at: iso(expiry(record)),
  };
};
const assertSize = (value, limit = ACTIVITY_LIMITS.snapshotBytes) => {
  if (byteSize(value) > limit)
    throw Object.assign(
      new HttpError(413, `Page activity exceeds its ${limit / 1024} KiB response budget`),
      {
        code: "progress_budget_exceeded",
      },
    );
};
const keys = new Set([
  "page_id",
  "progress_id",
  "lease_token",
  "message",
  "targets",
  "expected_heads",
  "clear",
]);

/** Observations have leases, not document history. Tokens stay in this instance
 * and are never included in a roster, broadcast, durable receipt, or storage.
 *
 * Expiry is lazy: `prune()` runs before every read, snapshot and event, and
 * every published entry carries its own `expires_at` (and `idle_at` for a
 * caret), which viewers apply on their clocks. The host sets no timer for it.
 * Under celld a timer belongs to the request that set it and keeps that
 * request in flight until it fires, so a 60 s presence timer per edit would
 * hold a slot of the Page's per-cell request limit for a minute per edit.
 */
export class PageActivity {
  constructor({
    pageId,
    access,
    readAccess = access,
    profiles,
    onChange = () => {},
    now = Date.now,
  }) {
    this.pageId = pageId;
    this.access = access;
    this.readAccess = readAccess;
    this.profiles = profiles;
    this.onChange = onChange;
    this.now = now;
    this.epoch = crypto.randomUUID();
    this.revision = 0;
    this.progress = new Map();
    this.selections = new Map();
    // API agents by principal and driver. Records follow agent-presence.mjs.
    this.agents = new Map();
  }

  permitted(record, now) {
    if (record.expiresAt <= now) return false;
    try {
      const access = this.access(record.identity);
      return access.canWrite && access.generation === record.generation;
    } catch {
      return false;
    }
  }

  snapshotOf(
    progress = this.progress,
    revision = this.revision,
    now = this.now(),
    agents = this.agents,
  ) {
    return {
      kind: "page-activity",
      epoch: this.epoch,
      revision,
      observed_at: iso(now),
      progress: [...progress.values()].map(publicProgress),
      agents: [...agents.values()].map(publicAgent),
    };
  }

  agentVisible(entry, now) {
    if (!(entry.identity.expiresAt > now)) return false;
    try {
      const access = this.readAccess(entry.identity);
      return access.canRead !== false && access.generation === entry.generation;
    } catch {
      return false;
    }
  }

  /** Record a targeted read or a committed write from an API agent. Presence
   * never fails the call it describes: an invalid identity or an oversized
   * snapshot leaves the roster unchanged. */
  agentEvent(identity, type, targets) {
    // Only API credentials get agent presence: a person's browser session
    // already shows their caret. Labels sit under the authenticated account.
    if (!["oauth", "api-key"].includes(identity?.credentialKind) || !Array.isArray(targets))
      return false;
    for (const [value, max] of [
      [identity.principal, 512],
      [identity.displayName, 256],
      [identity.driver, 128],
    ])
      if (typeof value !== "string" || !value || value.length > max) return false;
    if (
      identity.agent !== undefined &&
      (typeof identity.agent !== "string" || !identity.agent || identity.agent.length > 128)
    )
      return false;
    if (identity.session !== undefined && !/^[0-9a-f]{16}$/.test(identity.session)) return false;
    let generation;
    try {
      const access = this.readAccess(identity);
      if (access.canRead === false) return false;
      generation = access.generation;
    } catch {
      return false;
    }
    this.prune();
    const now = this.now();
    // One record per account, harness and session label.
    // One record per account, harness, session label and MCP session, so two
    // sessions on one credential keep separate carets.
    const key = [
      identity.principal,
      identity.driver,
      identity.agent ?? "",
      identity.session ?? "",
    ].join("\u0000");
    const previous = this.agents.get(key);
    const record = transition(previous?.record ?? null, {
      type,
      at: now,
      targets: targets.slice(0, AGENT_PRESENCE.maxTargets),
    });
    if (!record || record === previous?.record) return false;
    const candidate = new Map(this.agents);
    candidate.set(key, {
      agent_id: previous?.agent_id ?? crypto.randomUUID(),
      identity: { ...identity },
      generation,
      record,
    });
    const oldest = (entries) =>
      entries.reduce((a, b) => (b[1].record.lastCall < a[1].record.lastCall ? b : a));
    // Per account first, so one account varying its session id evicts only
    // its own least recent sessions, never other accounts' agents.
    for (;;) {
      const mine = [...candidate].filter(
        ([, entry]) => entry.identity.principal === identity.principal,
      );
      if (mine.length <= AGENT_PRESENCE.sessionsPerPrincipal) break;
      candidate.delete(oldest(mine)[0]);
    }
    // Over the Page-wide cap, the account that just grew gives up its own
    // least recent session when it has more than one, so an account varying
    // its session id never pushes out others. A new single-session account
    // evicts the globally least recent entry: plain LRU across accounts,
    // since otherwise a ninth agent could never appear.
    while (candidate.size > AGENT_PRESENCE.agents) {
      const mine = [...candidate].filter(
        ([, entry]) => entry.identity.principal === identity.principal,
      );
      candidate.delete(oldest(mine.length > 1 ? mine : [...candidate])[0]);
    }
    const next = this.snapshotOf(this.progress, this.revision + 1, now, candidate);
    if (byteSize(next) > ACTIVITY_LIMITS.snapshotBytes) return false;
    this.agents = candidate;
    this.revision++;
    this.onChange(this.snapshotOf());
    return true;
  }

  /** Drop what has expired and advance agent records that have faded. A
   * changed roster is broadcast; an unchanged one is not. */
  prune() {
    const now = this.now();
    let changed = false;
    for (const [id, record] of this.progress) {
      if (this.permitted(record, now)) continue;
      this.progress.delete(id);
      changed = true;
    }
    for (const [key, entry] of this.agents) {
      const record = this.agentVisible(entry, now)
        ? transition(entry.record, { type: "tick", at: now })
        : null;
      if (record === entry.record) continue;
      if (record) this.agents.set(key, { ...entry, record });
      else this.agents.delete(key);
      changed = true;
    }
    const profiles = this.profiles();
    for (const [senderId, record] of this.selections) {
      const profile = Object.hasOwn(profiles, senderId) && profiles[senderId];
      if (
        record.expiresAt <= now ||
        !profile ||
        record.principal !== profile.principal ||
        record.driver !== profile.driver
      )
        this.selections.delete(senderId);
    }
    if (changed) {
      this.revision++;
      this.onChange(this.snapshotOf());
    }
  }

  snapshot() {
    this.prune();
    return this.snapshotOf();
  }

  report(doc, identity, args) {
    if (
      !args ||
      typeof args !== "object" ||
      Array.isArray(args) ||
      Object.keys(args).some((key) => !keys.has(key)) ||
      args.page_id !== this.pageId
    )
      throw new HttpError(400, "Invalid progress arguments");
    if (args.clear !== undefined && typeof args.clear !== "boolean")
      throw new HttpError(400, "clear must be a boolean");
    const renewing = args.progress_id !== undefined || args.lease_token !== undefined;
    if (
      renewing &&
      (typeof args.progress_id !== "string" ||
        !/^[\da-f-]{36}$/.test(args.progress_id) ||
        typeof args.lease_token !== "string" ||
        !/^[\da-f-]{36}$/.test(args.lease_token))
    )
      throw new HttpError(400, "progress_id and lease_token are required together");
    if (
      args.clear &&
      (!renewing || ["message", "targets", "expected_heads"].some((key) => key in args))
    )
      throw new HttpError(400, "Clear requires only progress_id and lease_token");
    if (
      args.message !== undefined &&
      (typeof args.message !== "string" ||
        !args.message.trim() ||
        args.message.length > 240 ||
        // eslint-disable-next-line no-control-regex
        /[\x00-\x1f\x7f]/u.test(args.message))
    )
      throw new HttpError(400, "message must be plain text between 1 and 240 characters");
    if (!renewing && args.message === undefined)
      throw new HttpError(400, "message is required to start progress");
    if (args.expected_heads !== undefined && args.targets === undefined)
      throw new HttpError(400, "expected_heads requires targets");
    const access = this.access(identity);
    if (!access.canWrite) throw new HttpError(403, "Page is read-only");
    if (!Number.isFinite(identity.expiresAt) || identity.expiresAt <= this.now())
      throw new HttpError(403, "Progress credential has expired");
    for (const [field, max] of [
      ["principal", 512],
      ["displayName", 256],
      ["driver", 128],
    ])
      if (typeof identity[field] !== "string" || !identity[field] || identity[field].length > max)
        throw new HttpError(400, `Progress identity ${field} exceeds its display limit`);
    this.prune();
    const previous = renewing ? this.progress.get(args.progress_id) : undefined;
    if (renewing && !previous)
      throw Object.assign(new HttpError(404, "Progress session expired or was cleared"), {
        code: "progress_session_expired",
      });
    if (
      previous &&
      (previous.identity.principal !== identity.principal ||
        previous.identity.namespace !== identity.namespace ||
        previous.lease !== args.lease_token)
    )
      throw new HttpError(403, "Progress session access denied");
    if (args.clear) {
      this.progress.delete(args.progress_id);
      this.revision++;
      this.onChange(this.snapshotOf());
      return { page_id: this.pageId, progress_id: args.progress_id, cleared: true };
    }
    if (
      !previous &&
      (this.progress.size >= ACTIVITY_LIMITS.progress ||
        [...this.progress.values()].filter(
          (record) => record.identity.principal === identity.principal,
        ).length >= ACTIVITY_LIMITS.perPrincipal)
    )
      throw Object.assign(new HttpError(429, "Page progress session capacity reached"), {
        code: "progress_capacity_exceeded",
      });
    const now = this.now();
    const targets =
      args.targets === undefined
        ? (previous?.targets ?? [])
        : createProgressTargets(doc, args.targets, args.expected_heads);
    const record = {
      progress_id: previous?.progress_id ?? crypto.randomUUID(),
      lease: previous?.lease ?? crypto.randomUUID(),
      identity: { ...identity },
      generation: access.generation,
      message: args.message?.trim() ?? previous.message,
      targets,
      updatedAt: now,
      expiresAt: Math.min(now + ACTIVITY_LIMITS.ttl, identity.expiresAt),
    };
    const candidate = new Map(this.progress).set(record.progress_id, record);
    // Reject before changing a current lease, revision, or broadcast. One large
    // candidate must not erase a previously accepted indicator.
    assertSize(this.snapshotOf(candidate, this.revision + 1, now));
    this.progress = candidate;
    this.revision++;
    this.onChange(this.snapshotOf());
    return {
      page_id: this.pageId,
      ...publicProgress(record),
      targets: resolveProgressTargets(doc, record.targets),
      ...(!previous && { lease_token: record.lease }),
    };
  }

  receive({ senderId, message }) {
    if (message?.kind !== "selection") return;
    this.prune();
    const profiles = this.profiles();
    if (!Object.hasOwn(profiles, senderId)) return;
    const profile = profiles[senderId];
    if (message.value === null) {
      this.selections.delete(senderId);
      return;
    }
    const value = validatePeerSelection(message.value);
    if (!value) return;
    if (!this.selections.has(senderId) && this.selections.size >= ACTIVITY_LIMITS.peers) return;
    const now = this.now();
    this.selections.set(senderId, {
      value,
      principal: profile.principal,
      driver: profile.driver,
      observedAt: now,
      expiresAt: now + ACTIVITY_LIMITS.selectionTtl,
    });
  }

  read(doc) {
    this.prune();
    const result = {
      page_id: this.pageId,
      heads: A.getHeads(doc),
      observed_at: iso(this.now()),
      participants: Object.entries(this.profiles())
        .slice(0, ACTIVITY_LIMITS.peers)
        .map(([peer_id, profile]) => {
          const record = this.selections.get(peer_id);
          const selection = record && resolvePeerSelection(doc, record.value);
          return {
            peer_id,
            ...identityView(profile),
            ...(selection && { last_seen: iso(record.observedAt), selection }),
          };
        }),
      progress: [...this.progress.values()].map((record) => ({
        ...publicProgress(record),
        targets: resolveProgressTargets(doc, record.targets),
      })),
      agents: [...this.agents.values()].map((entry) => ({
        ...publicAgent(entry),
        targets: entry.record.targets.map((target) =>
          target.kind === "block"
            ? { kind: "block", block_id: target.block_id }
            : { kind: target.kind, ...resolvePeerSelection(doc, target) },
        ),
      })),
    };
    assertSize(result, ACTIVITY_LIMITS.readBytes);
    return result;
  }

  close() {
    this.selections.clear();
    this.progress.clear();
    this.agents.clear();
    this.revision++;
    this.onChange(this.snapshotOf());
  }
}
