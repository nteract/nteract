import { resolveProgressTargets, resolvePeerSelection } from "../model/presence.mjs";

const bounded = (value, max) =>
  typeof value === "string" && value.length > 0 && value.length <= max;
const endpoint = (value, blockId) =>
  value &&
  value.blockId === blockId &&
  bounded(value.textObjectId, 256) &&
  bounded(value.relativePositionBase64, 1024);

// Keep only the presentation fields from the authenticated host. In particular,
// a lease token or arbitrary caller-supplied identity never reaches UI state.
export function activitySnapshot(message, now = Date.now()) {
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
        message: item.message,
        targets,
        until: now + remaining,
      });
  }
  return { epoch: message.epoch, revision: message.revision, progress };
}

export function activityIdentity(identity) {
  const name = identity?.displayName?.trim() || "Collaborator";
  const driver = identity?.driver?.trim();
  const delegated = !!driver && driver.toLowerCase() !== "browser";
  return { name, driver, delegated, label: delegated ? `${driver} on behalf of ${name}` : name };
}

export function progressPassages(session, now = Date.now()) {
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

export function pageActivity(session, now = Date.now(), { resolveSelections = true } = {}) {
  const progress = [...(session.agentProgress?.values() ?? [])].filter((item) => item.until > now);
  const peers = [...(session.peers ?? [])]
    .filter(([, item]) => now - item.at <= 30000)
    .map(([id, item]) => ({
      id,
      ...item,
      ...(resolveSelections ? { selection: resolvePeerSelection(session.doc, item.value) } : {}),
    }));
  return { progress, peers };
}
