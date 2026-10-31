import {
  resolveProgressTargets,
  resolvePeerSelection,
  validatePeerSelection,
} from "../model/presence.mjs";
import { AGENT_PRESENCE, STATES } from "../model/agent-presence.mjs";
import { monotonicNow } from "./monotonic.mjs";

// Activity lifetimes are elapsed time on the session's monotonic clock
// (PageSession.now, monotonic.mjs): `until` and a peer's `at` are readings of
// it, so `now` must be too.
const sessionNow = (session) => session.now?.() ?? monotonicNow();

const bounded = (value, max) =>
  typeof value === "string" && value.length > 0 && value.length <= max;
const endpoint = (value, blockId) =>
  value &&
  value.blockId === blockId &&
  bounded(value.textObjectId, 256) &&
  bounded(value.relativePositionBase64, 1024);

// Keep only the presentation fields from the authenticated host. In particular,
// a lease token or arbitrary caller-supplied identity never reaches UI state.
export function activitySnapshot(message, now = monotonicNow()) {
  if (
    !message ||
    message.kind !== "page-activity" ||
    !bounded(message.epoch, 128) ||
    !Number.isSafeInteger(message.revision) ||
    message.revision < 0 ||
    !Array.isArray(message.progress) ||
    message.progress.length > 16
  )
    return null;
  const observedAt = Date.parse(message.observed_at);
  if (!Number.isFinite(observedAt)) return null;
  const progress = new Map();
  for (const item of message.progress) {
    if (
      !item ||
      !bounded(item.progress_id, 128) ||
      progress.has(item.progress_id) ||
      !bounded(item.principal, 512) ||
      !bounded(item.displayName, 256) ||
      !bounded(item.driver, 128) ||
      !bounded(item.message, 500) ||
      !Array.isArray(item.targets) ||
      item.targets.length > 3
    )
      return null;
    const remaining = Date.parse(item.expires_at) - observedAt;
    if (!Number.isFinite(remaining) || remaining > 60000) return null;
    const targets = [];
    for (const anchor of item.targets) {
      if (
        !anchor ||
        !bounded(anchor.block_id, 128) ||
        !bounded(anchor.quote, 1024) ||
        anchor.target?.kind !== "selection" ||
        !endpoint(anchor.target.anchor, anchor.block_id) ||
        !endpoint(anchor.target.head, anchor.block_id)
      )
        return null;
      const copy = ({ blockId, textObjectId, relativePositionBase64 }) => ({
        blockId,
        textObjectId,
        relativePositionBase64,
      });
      targets.push({
        block_id: anchor.block_id,
        quote: anchor.quote,
        target: {
          kind: "selection",
          anchor: copy(anchor.target.anchor),
          head: copy(anchor.target.head),
        },
      });
    }
    if (remaining > 0)
      progress.set(item.progress_id, {
        progress_id: item.progress_id,
        principal: item.principal,
        displayName: item.displayName,
        driver: item.driver,
        agent: bounded(item.agent, 128) ? item.agent : null,
        message: item.message,
        targets,
        until: now + remaining,
      });
  }
  return {
    epoch: message.epoch,
    revision: message.revision,
    progress,
    agents: agentSnapshot(message.agents, observedAt, now),
  };
}

const TEXT_KINDS = ["text", "hit", "passage"];

// Agent entries are validated one at a time: a bad entry drops only itself, so
// a newer host's agent fields never hide progress or other agents.
function agentSnapshot(agents, observedAt, now) {
  const result = new Map();
  if (!Array.isArray(agents)) return result;
  for (const item of agents.slice(0, AGENT_PRESENCE.agents)) {
    if (
      !item ||
      !bounded(item.agent_id, 128) ||
      result.has(item.agent_id) ||
      !bounded(item.principal, 512) ||
      !bounded(item.displayName, 256) ||
      !bounded(item.driver, 128) ||
      !STATES.includes(item.state) ||
      !Number.isSafeInteger(item.seq) ||
      item.seq < 1 ||
      !Array.isArray(item.targets) ||
      item.targets.length > AGENT_PRESENCE.maxTargets
    )
      continue;
    const remaining = Date.parse(item.expires_at) - observedAt;
    if (!Number.isFinite(remaining) || remaining > AGENT_PRESENCE.idleMs || remaining <= 0)
      continue;
    const targets = [];
    for (const target of item.targets) {
      if (target?.kind === "block" && bounded(target.block_id, 128))
        targets.push({ kind: "block", block_id: target.block_id });
      else if (TEXT_KINDS.includes(target?.kind)) {
        const value = validatePeerSelection(target);
        if (value) targets.push({ kind: target.kind, ...value });
      }
    }
    result.set(item.agent_id, {
      agent_id: item.agent_id,
      principal: item.principal,
      displayName: item.displayName,
      driver: item.driver,
      agent:
        item.agent === null || item.agent === undefined
          ? null
          : bounded(item.agent, 128)
            ? item.agent
            : null,
      state: item.state,
      seq: item.seq,
      targets,
      until: now + remaining,
    });
  }
  return result;
}

export function activityIdentity(identity) {
  const name = identity?.displayName?.trim() || "Collaborator";
  const driver = identity?.driver?.trim();
  const delegated = !!driver && driver.toLowerCase() !== "browser";
  return { name, driver, delegated, label: delegated ? `${driver} on behalf of ${name}` : name };
}

export function progressPassages(session, now = sessionNow(session)) {
  const result = [];
  for (const progress of session.agentProgress?.values() ?? []) {
    if (progress.until <= now) continue;
    for (const [index, target] of resolveProgressTargets(session.doc, progress.targets).entries()) {
      if (target.status !== "attached") continue;
      result.push({ ...target, progress, index });
    }
  }
  return result;
}

/** One key per agent session: account, harness and optional session label.
 * A caret and a progress lease with the same key are one participant. */
export const agentKey = (item) =>
  [item.principal ?? "", item.driver ?? "", item.agent ?? ""].join("\u0000");

/** Agents in this Page, merged: each has its caret or reading marker (if any)
 * and its live progress leases, newest first. */
export function agentParticipants(session, now = sessionNow(session)) {
  const participants = new Map();
  const entry = (item) => {
    const key = agentKey(item);
    if (!participants.has(key))
      participants.set(key, {
        key,
        principal: item.principal,
        displayName: item.displayName,
        driver: item.driver,
        agent: item.agent ?? null,
        presence: null,
        progress: [],
      });
    return participants.get(key);
  };
  for (const item of session.agentPresence?.values() ?? [])
    if (item.until > now) entry(item).presence = item;
  for (const item of session.agentProgress?.values() ?? [])
    if (item.until > now) entry(item).progress.push(item);
  for (const participant of participants.values())
    participant.progress.sort((a, b) => b.until - a.until);
  return [...participants.values()];
}

export function pageActivity(
  session,
  now = sessionNow(session),
  { resolveSelections = true } = {},
) {
  const progress = [...(session.agentProgress?.values() ?? [])].filter((item) => item.until > now);
  const agents = agentParticipants(session, now);
  const peers = [...(session.peers ?? [])]
    .filter(([, item]) => now - item.at <= 30000)
    .map(([id, item]) => ({
      id,
      ...item,
      ...(resolveSelections ? { selection: resolvePeerSelection(session.doc, item.value) } : {}),
    }));
  return { progress, agents, peers };
}
