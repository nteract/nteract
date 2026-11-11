import { normalizeAgentAssertions } from "../shared/client-provenance.mjs";
import { declaredLabels, requestClient } from "./usage.mjs";

const requestAgents = new WeakMap();
const INTERNAL_AGENT = "x-pages-internal-request-agent";

/** Attach MCP request assertions without adding tool arguments or accepting a
 * public header as an alternate structured metadata protocol. */
export function withMcpAgent(request, agent) {
  if (!agent) return request;
  const scoped = new Request(request.url, { method: request.method, headers: request.headers });
  requestAgents.set(scoped, normalizeAgentAssertions(agent));
  return scoped;
}

function requestAgent(request) {
  const local = requestAgents.get(request);
  if (local) return local;
  if (!new URL(request.url).pathname.startsWith("/internal/")) return undefined;
  const encoded = request.headers.get(INTERNAL_AGENT);
  if (encoded === null) return undefined;
  try {
    if (encoded.length > 2048) throw Error();
    return normalizeAgentAssertions(JSON.parse(decodeURIComponent(encoded)));
  } catch {
    throw Object.assign(new Error("Invalid internal agent assertions"), {
      status: 400,
      code: "invalid_arguments",
    });
  }
}

/** Only gateway-created internal requests carry structured assertions. Every
 * receiving owner still authenticates the original credential independently. */
export function forwardClientProvenance(request, headers) {
  const path = new URL(request.url).pathname;
  const labels =
    path === "/mcp" || path.startsWith("/internal/")
      ? requestClient(request)
      : declaredLabels(request);
  for (const field of ["client", "model"]) {
    if (labels[field]) headers.set(`x-pages-${field}`, labels[field]);
  }
  const agent = requestAgent(request);
  if (agent) headers.set(INTERNAL_AGENT, encodeURIComponent(JSON.stringify(agent)));
}

/** What a client said about itself, as `{ name?, model? }` or undefined:
 * `_meta.agent` first, then the X-Pages-Agent name and X-Pages-Model model
 * that `provenance` (from clientProvenance) already resolved. The harness and
 * `agent.id` are not part of it. Text outside the `_meta.agent` bounds,
 * such as a header name with a bidi control, refuses with invalid_arguments. */
export function agentFromProvenance(provenance) {
  const { agent, model } = provenance?.assertions ?? {};
  return normalizeAgentAssertions({
    ...(agent?.name && { name: agent.name }),
    ...(model && { model }),
  });
}

/** The resolved assertion for one request. Throws on the same conflicts as
 * clientProvenance. */
export function agentAssertion(request, legacyAgent) {
  return agentFromProvenance(clientProvenance(request, legacyAgent));
}

/** Private request context, excluded from receipts, broadcasts and author
 * fields. A durable consumer binds the resolved assertion into its request
 * fingerprint (comment writes do), so a retry with changed assertions
 * conflicts instead of replaying. */
export function clientProvenance(request, legacyAgent) {
  const explicit = requestAgent(request);
  // Transport session IDs are correlation credentials, not harness agent IDs.
  // Only MCP requests and their internal forwards may recover clientInfo.
  const path = new URL(request.url).pathname;
  const mcp = path === "/mcp" || path.startsWith("/internal/");
  const labels = mcp ? requestClient(request) : declaredLabels(request);
  if (
    (explicit?.name && legacyAgent && explicit.name !== legacyAgent) ||
    (explicit?.model && labels.model && explicit.model !== labels.model)
  ) {
    throw Object.assign(new Error("Conflicting agent assertions and legacy headers"), {
      status: 400,
      code: "invalid_arguments",
    });
  }
  const name = explicit?.name ?? legacyAgent;
  const model = explicit?.model ?? labels.model;
  if (!labels.client && !name && !explicit?.id && !model) return undefined;
  const agent = { ...(name && { name }), ...(explicit?.id && { id: explicit.id }) };
  return Object.freeze({
    schema_version: 1,
    assertions: Object.freeze({
      ...(labels.client && { harness: labels.client }),
      ...(Object.keys(agent).length && { agent: Object.freeze(agent) }),
      ...(model && { model }),
    }),
  });
}
