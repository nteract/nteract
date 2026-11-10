// Node-only loopback fake of the two Kilo routes Pages signs in through
// (worker/kilo-exchange.mjs): the page a browser is sent to, and the code
// exchange. It allows a list of Pages origins, issues single-use codes that
// expire, and checks the exchange secret.
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

const CODE_SECONDS = 60;
const send = (res, status, value) =>
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));

/** Starts the fake. `origins` are the Pages origins it redirects to and
 * `secret` is what the exchange requires. `signIn(account)` sets who the
 * browser is at Kilo, or nobody with `null`; `respond(fn)` replaces the next
 * exchange answer with `fn(req, res)`. */
export async function startLocalKiloHandoff({ origins, secret, port = 0, now = Date.now }) {
  const codes = new Map();
  const exchanges = [];
  let account = null;
  let override = null;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/pages/enter") {
      const origin = url.searchParams.get("origin");
      const state = url.searchParams.get("state");
      if (!origins.includes(origin) || !state) return send(res, 400, { error: "bad_request" });
      // The real page sends a browser without a session to sign in first.
      if (!account) return send(res, 401, { error: "signed_out" });
      const code = randomBytes(32).toString("base64url");
      codes.set(code, { origin, account, expiresAt: now() + CODE_SECONDS * 1000 });
      const callback = new URL("/api/auth/kilo/callback", origin);
      callback.search = new URLSearchParams({ code, state }).toString();
      return res.writeHead(302, { location: callback.href }).end();
    }
    if (req.method === "POST" && url.pathname === "/api/pages/exchange") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        return send(res, 400, { error: "bad_json" });
      }
      exchanges.push({ authorization: req.headers.authorization, origin: body?.origin });
      if (override) {
        const answer = override;
        override = null;
        return answer(req, res);
      }
      if (req.headers.authorization !== `Bearer ${secret}`)
        return send(res, 401, { error: "bad_client" });
      const issued = codes.get(body?.code);
      codes.delete(body?.code);
      if (!issued || issued.origin !== body.origin || issued.expiresAt <= now())
        return send(res, 400, { error: "bad_code" });
      return send(res, 200, {
        user: { id: issued.account.id, name: issued.account.name, email: issued.account.email },
      });
    }
    return send(res, 404, { error: "not_found" });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    signIn(next) {
      account = next;
    },
    respond(answer) {
      override = answer;
    },
    exchanges: () => exchanges.slice(),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
}
