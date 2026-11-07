import { INVALID_PAGE_CONTENT, PAGE_CONTENT_RULES } from "../model/page-admission.mjs";
import { ADMISSION_OUTCOMES } from "../shared/admission.mjs";
import { validPageId } from "./registration.mjs";

// Structured lines for plain Automerge sync, one JSON object each, in the
// style of `admission.denied` and `pages.usage.v1`. They carry the Page id,
// the document kind, codes and counts; never principals, tokens, actor ids,
// messages or document content.
//
//   page.sync_refused  one browser frame the host refused. The first refusal
//                      per connection and reason is logged at once; repeats
//                      are counted and logged once when the socket closes.
//                      A Page-content refusal (invalid_page_content) names
//                      the rule it broke and carries no Page id: its count
//                      is the signal, and the Page's content stays private.
//   page.sync_rounds   sync-round latency for one browser connection: the
//                      time from a frame's arrival to its ack, for frames
//                      whose changes were stored. A browser sends a frame per
//                      batch of edits, so rounds are summarised, not logged:
//                      one line per 256 rounds and one when the socket closes.

const SERVICE = "nteract-pages-native";
const REASON = /^[a-z0-9_]{1,64}$/;
const KINDS = new Set(["page", "comments"]);
const CREDENTIALS = new Set(["oidc", "api-key", "oauth", "session"]);

const pageIdOf = (value) => (validPageId(value) ? value : undefined);
const credentialOf = (value) => (CREDENTIALS.has(value) ? value : "none");
const finite = (value) => (Number.isFinite(value) && value >= 0 ? Math.round(value) : 0);
const clean = (record) => {
  for (const key of Object.keys(record)) if (record[key] === undefined) delete record[key];
  return record;
};

/** One `page.sync_refused` record. `code`, `status` and `close` are the
 * client-safe admission outcome a fatal refusal closes the socket with.
 * `rule` is set for a Page-content refusal, which omits `page_id`. */
export function syncRefusedRecord({
  pageId,
  kind,
  refusal,
  credential,
  repeats = 0,
  now = new Date(),
}) {
  const fatal = refusal?.fatal === true;
  const outcome = fatal
    ? Object.hasOwn(ADMISSION_OUTCOMES, refusal.close?.reason)
      ? refusal.close.reason
      : "request_rejected"
    : undefined;
  const content = refusal?.code === INVALID_PAGE_CONTENT;
  return clean({
    service: SERVICE,
    event: "page.sync_refused",
    page_id: content ? undefined : pageIdOf(pageId),
    doc: KINDS.has(kind) ? kind : "unknown",
    reason: REASON.test(refusal?.code ?? "") ? refusal.code : "unknown",
    rule: content
      ? PAGE_CONTENT_RULES.includes(refusal.rule)
        ? refusal.rule
        : "unknown"
      : undefined,
    fatal,
    code: outcome,
    status: outcome && ADMISSION_OUTCOMES[outcome].status,
    close: outcome && (refusal.close?.code ?? ADMISSION_OUTCOMES[outcome].close),
    credential: credentialOf(credential),
    repeats: repeats > 0 ? finite(repeats) : undefined,
    timestamp: now.toISOString(),
  });
}

/** Upper bounds (ms, inclusive) of the latency buckets; the last is open. */
export const ROUND_BUCKETS_MS = Object.freeze([10, 25, 50, 100, 250, 500, 1000, 2500, 5000]);
export const ROUNDS_PER_RECORD = 256;

// Rounds summary per connection:
//
//   empty       no rounds since the last record
//   collecting  rounds summarised, not yet logged
//   closed      the socket closed; later rounds are dropped
//
// `roundsStep` is the only transition; `emit` is a summary to log, or null.

export const ROUNDS_EMPTY = Object.freeze({ phase: "empty" });
const ROUNDS_CLOSED = Object.freeze({ phase: "closed" });

const emptySummary = () => ({
  rounds: 0,
  changes: 0,
  bytes: 0,
  msSum: 0,
  msMax: 0,
  waitMsSum: 0,
  buckets: Array(ROUND_BUCKETS_MS.length + 1).fill(0),
});

function addRound(summary, { ms, waitMs, changes, bytes }) {
  const latency = finite(ms);
  const bucket = ROUND_BUCKETS_MS.findIndex((bound) => latency <= bound);
  const buckets = [...summary.buckets];
  buckets[bucket === -1 ? ROUND_BUCKETS_MS.length : bucket]++;
  return {
    rounds: summary.rounds + 1,
    changes: summary.changes + finite(changes),
    bytes: summary.bytes + finite(bytes),
    msSum: summary.msSum + latency,
    msMax: Math.max(summary.msMax, latency),
    waitMsSum: summary.waitMsSum + finite(waitMs),
    buckets,
  };
}

/**
 * One transition. Events: `{ type: "round", ms, waitMs, changes, bytes }` and
 * `{ type: "close" }`. Returns `{ state, emit }`.
 */
export function roundsStep(state, event, { perRecord = ROUNDS_PER_RECORD } = {}) {
  if (state.phase === "closed") return { state, emit: null };
  if (event.type === "close")
    return {
      state: ROUNDS_CLOSED,
      emit: state.phase === "collecting" ? state.summary : null,
    };
  if (event.type === "round") {
    const summary = addRound(state.phase === "collecting" ? state.summary : emptySummary(), event);
    return summary.rounds >= perRecord
      ? { state: ROUNDS_EMPTY, emit: summary }
      : { state: { phase: "collecting", summary }, emit: null };
  }
  throw new TypeError(`No rounds transition for ${event.type} in ${state.phase}`);
}

/** One `page.sync_rounds` record from a summary. Bucket keys are the
 * inclusive upper bound in ms, and "+Inf". */
export function syncRoundsRecord({ pageId, summary, credential, now = new Date() }) {
  return clean({
    service: SERVICE,
    event: "page.sync_rounds",
    page_id: pageIdOf(pageId),
    credential: credentialOf(credential),
    rounds: summary.rounds,
    changes: summary.changes,
    bytes: summary.bytes,
    latency_ms_sum: summary.msSum,
    latency_ms_max: summary.msMax,
    wait_ms_sum: summary.waitMsSum,
    latency_ms_buckets: Object.fromEntries(
      summary.buckets.map((count, i) => [String(ROUND_BUCKETS_MS[i] ?? "+Inf"), count]),
    ),
    timestamp: now.toISOString(),
  });
}

/** Emit a line. Telemetry must never fail a frame. */
function emit(level, build) {
  try {
    const record = build();
    console[level](JSON.stringify(record));
    return record;
  } catch {
    return undefined;
  }
}

export const logSyncRefused = (fields) => emit("warn", () => syncRefusedRecord(fields));
export const logSyncRounds = (fields) => emit("info", () => syncRoundsRecord(fields));
