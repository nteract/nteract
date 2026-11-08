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

/** Private request context, excluded from receipts, fingerprints, broadcasts
 * and author fields. Durable consumers must first bind an immutable snapshot
 * to the logical operation and fence retries against changed assertions. */
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
    // Field origin only, not publication consent. Consumers must not infer
    // explicit assertions from the merged private telemetry labels below.
    ...(explicit && { explicitAgent: explicit }),
    assertions: Object.freeze({
      ...(labels.client && { harness: labels.client }),
      ...(Object.keys(agent).length && { agent: Object.freeze(agent) }),
      ...(model && { model }),
    }),
  });
}
