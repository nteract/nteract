/** Usage events: one structured JSON line per meaningful action, so Pages
 * usage can be split by person, surface, client (harness) and model.
 *
 * Sink: celld exports Worker console lines as OTel log bodies, which land as
 * Parquet under `<fleet-prefix>/telemetry/logs/` (DEPLOYMENT.md, Telemetry).
 * Each line is a single JSON object with a versioned `event` name, so duckdb
 * can read it straight from S3 (scripts/usage-report.sql).
 *
 * Never logged: document content, titles, argument values other than page and
 * project ids, tokens, keys, cookies, raw MCP session ids or emails. Principals and display names are recorded
 * (Anaconda-internal, authorized). A display name falls back to the account
 * email when the profile has no name, so an email-shaped one is dropped.
 * Client and model labels are self-declared and informational only: nothing
 * reads them for auth.
 *
 * Surfaces: `mcp` for /mcp, `http-tools` for /api/tools (agents and the
 * browser UI's own calls, told apart by driver), and `browser-sync` for the
 * browser's native Page traffic: registering a Page it created, and admitted
 * sync connections.
 *
 * Emission never fails or delays a request. A record that can't be built or
 * written is dropped and counted; the next record carries the count as
 * `dropped`. */

import { validPageId } from "./registration.mjs";
import { validSpaceId } from "./spaces.mjs";
import { enqueueUsage } from "./usage-store.mjs";

export const USAGE_EVENT = "pages.usage.v1";
export const USAGE_ACTIONS = Object.freeze([
  "mcp.initialize",
  "tool.call",
  "page.create",
  "page.write",
  "comment.write",
  "page.read",
  "page.visit",
  "sync.open",
  "sync.close",
]);
export const USAGE_SURFACES = Object.freeze(["mcp", "http-tools", "browser-sync"]);
/** What an MCP or HTTP call asked for: a tool, or an MCP resource list/read. */
export const USAGE_KINDS = Object.freeze(["tool", "resource"]);
/** Set by the Catalog on a create or register response that replays a stored
 * receipt, so the gateway counts each Page creation once. Internal: the
 * gateway strips it before a response leaves. */
export const REPLAYED_RECEIPT_HEADER = "x-pages-receipt-replayed";
/** Longest client or model label kept; longer values are truncated. */
export const LABEL_LIMIT = 120;

/** A self-declared label, trimmed, control characters removed, truncated to
 * `limit`. Anything that leaves nothing (or a non-string) is undefined. Never
 * throws: a bad informational header must not fail a request. */
export function cleanLabel(value, limit = LABEL_LIMIT) {
  if (typeof value !== "string") return undefined;
  // Printable ASCII only: labels are harness and model ids, and this keeps
  // the log line free of control and bidi characters.
  const cleaned = value.replace(/[^\x20-\x7e]/g, "").trim();
  if (!cleaned) return undefined;
  return cleaned.length > limit ? cleaned.slice(0, limit) : cleaned;
}

/** The optional X-Pages-Client (`<harness>/<version>`) and X-Pages-Model
 * (`<model id>`) headers. */
export function declaredLabels(request) {
  const client = cleanLabel(request.headers.get("x-pages-client"));
  const model = cleanLabel(request.headers.get("x-pages-model"));
  return { ...(client && { client }), ...(model && { model }) };
}

/** `name/version` from MCP initialize clientInfo, or undefined. */
export function mcpClientLabel(clientInfo) {
  if (!clientInfo || typeof clientInfo !== "object") return undefined;
  const name = cleanLabel(clientInfo.name, 64);
  if (!name) return undefined;
  const version = cleanLabel(clientInfo.version, 32);
  return version ? `${name}/${version}` : name;
}

const toBase64Url = (bytes) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
const fromBase64Url = (text) =>
  Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));

/** The Mcp-Session-Id issued at initialize. MCP here is stateless, so the
 * client's `name/version` rides in the id itself: `<uuid>.<base64url label>`.
 * Clients echo the id on every request, which carries clientInfo onto later
 * tool calls with no server state. The id stays within auth.mjs's
 * `[A-Za-z0-9._-]{8,128}` shape. */
export function mcpSessionId(clientInfo, uuid = crypto.randomUUID()) {
  const label = mcpClientLabel(clientInfo);
  if (!label) return uuid;
  // 36 (uuid) + 1 (dot) + 88 base64 chars = 125 ≤ 128.
  const bytes = new TextEncoder().encode(label).slice(0, 66);
  return `${uuid}.${toBase64Url(bytes)}`;
}

/** The uuid half of every modern client id: constant, so the id depends only
 * on the client's label. */
export const MODERN_MCP_CLIENT_UUID = "00000000-0000-4000-8000-000000000000";

/** `request` as the gateway invokes a tool for an MCP protocol 2026-07-28
 * request. That revision has no session: every request declares its
 * clientInfo in `_meta`, and a client's Mcp-Session-Id header is ignored. The
 * gateway's own invocation request carries an Mcp-Session-Id built from that
 * clientInfo (mcpSessionId with MODERN_MCP_CLIENT_UUID), so usage
 * (requestClient) and presence (auth.mjs sessionTag) read the client the way
 * they read a legacy session. One principal's requests from one client
 * name/version share a presence tag; without a clientInfo they share the bare
 * uuid's. Only the headers are copied: the body was already read. */
export function withModernMcpClient(request, clientInfo) {
  const headers = new Headers(request.headers);
  headers.set("mcp-session-id", mcpSessionId(clientInfo, MODERN_MCP_CLIENT_UUID));
  return new Request(request.url, { method: request.method, headers });
}

/** The clientInfo label carried in an Mcp-Session-Id, or undefined. */
export function mcpSessionClient(sessionId) {
  if (typeof sessionId !== "string") return undefined;
  const match = sessionId.match(/^[0-9a-f-]{36}\.([A-Za-z0-9_-]{1,88})$/);
  if (!match) return undefined;
  try {
    return cleanLabel(new TextDecoder("utf-8", { fatal: false }).decode(fromBase64Url(match[1])));
  } catch {
    return undefined;
  }
}

/** Client attribution for a request: the declared header wins, then MCP
 * clientInfo from the session id. */
export function requestClient(request) {
  const declared = declaredLabels(request);
  const mcpClient = mcpSessionClient(request.headers.get("mcp-session-id"));
  return {
    ...declared,
    ...(!declared.client && mcpClient && { client: mcpClient }),
    ...(mcpClient && { mcp_client: mcpClient }),
  };
}

/** Whether `response` replays a stored creation receipt, and the response
 * without the internal marker, ready to leave the gateway. */
export function takeReplayedReceipt(response) {
  try {
    if (!response.headers.has(REPLAYED_RECEIPT_HEADER)) return { response, replayed: false };
    const headers = new Headers(response.headers);
    headers.delete(REPLAYED_RECEIPT_HEADER);
    return {
      response: new Response(response.body, { status: response.status, headers }),
      replayed: true,
    };
  } catch {
    usageDropped();
    return { response, replayed: false };
  }
}

/** The operation name to record: `name` when it is in `known`, else
 * "unknown". Names come straight from a caller's request, even on a refused
 * call, so only known names reach the log. */
export function usageOperation(name, known) {
  return typeof name === "string" && known.has(name) ? name : "unknown";
}

const finite = (value) => (Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined);
// Ids can come straight from a caller's request too. Only real Page and
// Project ids are kept, so no free text reaches the log.
const pageIdOf = (value) => (validPageId(value) ? value : undefined);
const projectIdOf = (value) => (validSpaceId(value) ? value : undefined);
const outcomeOf = (value) =>
  typeof value === "string" && /^[a-z0-9_]{1,64}$/.test(value) ? value : undefined;
// Callers pick operation names through usageOperation; this is the backstop.
const operationOf = (value) =>
  value === undefined ? undefined : /^[a-z_]{1,64}$/.test(value) ? value : "unknown";

/** Account-supplied text (driver, agent, display name) with control and
 * format characters (\p{Cc}, \p{Cf}, including bidi overrides) removed,
 * trimmed, and capped at `limit` code points. Undefined when nothing is left. */
export function cleanText(value, limit) {
  if (typeof value !== "string") return undefined;
  const cleaned = [...value.replace(/[\p{Cc}\p{Cf}]/gu, "").trim()].slice(0, limit).join("");
  return cleaned.trim() || undefined;
}
// Display names fall back to the account email (apps/notebook-cloud
// host-session.ts) when a profile has no name or username.
const displayName = (value) => {
  const cleaned = cleanText(value, 256);
  return cleaned && !cleaned.includes("@") ? cleaned : undefined;
};

let dropped = 0;
/** Count a usage record that was lost. The next emitted record reports it. */
export function usageDropped() {
  dropped++;
}

/** Build one usage record. Unknown keys are dropped; absent values omitted. */
export function usageEvent({
  action,
  surface,
  identity,
  labels = {},
  operation,
  kind,
  admitted,
  pageId,
  projectId,
  outcome,
  status,
  latencyMs,
  bytes,
  protocolVersion,
  now = new Date(),
}) {
  if (!USAGE_ACTIONS.includes(action)) throw new TypeError(`Unknown usage action ${action}`);
  const record = {
    service: "nteract-pages-native",
    event: USAGE_EVENT,
    action,
    surface: USAGE_SURFACES.includes(surface) ? surface : "unknown",
    principal: identity?.principal,
    display_name: displayName(identity?.displayName),
    namespace: identity?.namespace,
    credential: identity?.credentialKind,
    driver: cleanText(identity?.driver, 80),
    agent: cleanText(identity?.agent, 80),
    session: identity?.session,
    client: labels.client,
    mcp_client: labels.mcp_client,
    model: labels.model,
    operation: operationOf(operation),
    kind: USAGE_KINDS.includes(kind) ? kind : undefined,
    admitted: typeof admitted === "boolean" ? admitted : undefined,
    page_id: pageIdOf(pageId),
    project_id: projectIdOf(projectId),
    outcome: outcomeOf(outcome),
    status: Number.isSafeInteger(status) ? status : undefined,
    latency_ms: finite(latencyMs),
    bytes: finite(bytes),
    protocol_version: cleanLabel(protocolVersion, 32),
    timestamp: now.toISOString(),
  };
  for (const key of Object.keys(record)) if (record[key] === undefined) delete record[key];
  return record;
}

/** Emit one usage line. Telemetry must never fail the request: a failure is
 * counted, and the next line carries the count as `dropped`. */
export function logUsage(fields, env) {
  try {
    const record = usageEvent(fields);
    enqueueUsage(record, env);
    if (dropped) record.dropped = dropped;
    console.info(JSON.stringify(record));
    dropped = 0;
    return record;
  } catch {
    usageDropped();
    return undefined;
  }
}
