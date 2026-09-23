/** Internal service-binding protocol. Never mount this on a public route. */
export function createProviderService(pool) {
  return {
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/health" && request.method === "GET") {
        return Response.json({ provider: "celld-pyodide", version: 1 });
      }
      if (request.method !== "POST" || !["/open", "/execute", "/close"].includes(path)) {
        return new Response("Not found", { status: 404 });
      }
      // These identities come from the cloud's authenticated attachment, never
      // from Python or a client-selected principal. Include every authority
      // dimension to prevent sessions crossing owners/notebooks/generations.
      const body = await request.text();
      if (body.length > 1_100_000) return new Response("Request too large", { status: 413 });
      let input;
      try {
        input = JSON.parse(body);
      } catch {
        return new Response("Invalid JSON", { status: 400 });
      }
      if (!input || typeof input !== "object" || Array.isArray(input))
        return new Response("Invalid request", { status: 400 });
      const parts = [input.ownerPrincipal, input.notebookId, input.sessionId];
      if (
        parts.some((part) => typeof part !== "string" || part.length === 0 || part.length > 512)
      ) {
        return new Response("Invalid session identity", { status: 400 });
      }
      const key = JSON.stringify(parts);
      try {
        if (path === "/open")
          return Response.json({ info: await pool.open(key, input.ownerPrincipal) });
        if (path === "/close") {
          await pool.release(key);
          return Response.json({ ok: true });
        }
        return Response.json(await pool.execute(key, input.execution));
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 409 });
      }
    },
  };
}
