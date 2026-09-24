/** Internal service-binding protocol. Never mount this on a public route. */
export function createProviderService(pool, storage) {
  // Only admission/fencing is serialized. Never hold this queue while Python
  // initializes or executes: close must be able to interrupt either operation.
  let mutations = Promise.resolve();
  const closed = new Set();
  const mutate = (fn) => {
    const next = mutations.then(fn);
    mutations = next.catch(() => undefined);
    return next;
  };
  return {
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/health" && request.method === "GET") {
        return Response.json({ provider: "celld-pyodide", version: 1 });
      }
      if (
        request.method !== "POST" ||
        !["/open", "/execute", "/close", "/inspect"].includes(path)
      ) {
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
        if (path === "/open" || path === "/close") {
          const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
          const fence =
            "released:" +
            Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
          const { operation } = await mutate(async () => {
            if (path === "/close") {
              // Persist before cleanup, including close-before-open. A delayed
              // request must never resurrect a released session generation.
              if (storage) await storage.put(fence, true);
              else closed.add(key);
              return { operation: pool.release(key) };
            }
            if (storage ? await storage.get(fence) : closed.has(key))
              throw new Error("Session was released; allocate a new runtime session");
            return { operation: pool.open(key, input.ownerPrincipal) };
          });
          // Attach rejection handling before yielding the admission queue.
          const result = await operation;
          return Response.json(path === "/open" ? { info: result } : { ok: true });
        }
        if (path === "/inspect") return Response.json(pool.inspect(key));
        return Response.json(await pool.execute(key, input.execution));
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 409 });
      }
    },
  };
}
