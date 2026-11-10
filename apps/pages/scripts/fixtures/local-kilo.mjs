// Node-only loopback Kilo fake. It models device approval, expiry, single-use
// codes, short-lived access tokens, and rotating refresh sessions for tests.
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

const opaque = () => randomBytes(32).toString("base64url");
const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const code = () => {
  const chars = Array.from({ length: 8 }, () => alphabet[randomBytes(1)[0] % alphabet.length]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
};
const send = (res, status, value) =>
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));

export async function startLocalKilo({ port = 0, now = Date.now } = {}) {
  const pending = new Map();
  const sessions = new Map();
  const refreshes = new Map();
  // Retired refresh token → its session. Kilo treats reuse of one as theft.
  const retiredRefreshes = new Map();
  const requests = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 64 * 1024) return send(res, 413, { error: "too_large" });
      chunks.push(chunk);
    }
    let body = {};
    if (chunks.length) {
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        return send(res, 400, { error: "bad_json" });
      }
    }
    requests.push({
      method: req.method,
      path: url.pathname,
      forwardedFor: req.headers["x-forwarded-for"],
    });

    if (req.method === "POST" && url.pathname === "/api/device-auth/codes") {
      const client = body?.requesting_client;
      if (
        !client ||
        ![client.client_id, client.client_name, client.redirect_origin].every(
          (v) => typeof v === "string" && v.length >= 1 && v.length <= 200,
        )
      )
        return send(res, 400, { error: "bad_client" });
      const ip = req.headers["x-forwarded-for"] ?? "unknown";
      for (const [key, item] of pending)
        if (item.state !== "pending" || item.expiresAt <= now()) pending.delete(key);
      if (
        [...pending.values()].filter((item) => item.state === "pending" && item.ip === ip).length >=
        5
      )
        return send(res, 429, { error: "rate_limited" });
      const userCode = code();
      const deviceCode = opaque();
      const item = {
        userCode,
        deviceCode,
        client,
        ip,
        expiresAt: now() + 600_000,
        state: "pending",
      };
      pending.set(userCode, item);
      const origin = `http://127.0.0.1:${server.address().port}`;
      return send(res, 200, {
        code: opaque(),
        user_code: userCode,
        device_code: deviceCode,
        verificationUrl: `${origin}/device-auth?code=${userCode}`,
        expiresIn: 600,
        requestingClient: {
          clientId: client.client_id,
          clientName: client.client_name,
          redirectOrigin: client.redirect_origin,
        },
      });
    }
    if (req.method === "POST" && url.pathname === "/__fake/approve") {
      const item = pending.get(body?.userCode);
      if (!item || item.state !== "pending" || item.expiresAt <= now() || !body.user)
        return send(res, 404, { error: "not_pending" });
      item.user = body.user;
      item.state = "approved";
      return send(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/__fake/deny") {
      const item = pending.get(body?.userCode);
      if (!item || item.state !== "pending" || item.expiresAt <= now())
        return send(res, 404, { error: "not_pending" });
      item.state = "denied";
      return send(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/api/device-auth/token") {
      const item = [...pending.values()].find(
        (candidate) => candidate.deviceCode === body?.deviceCode,
      );
      if (!item || item.expiresAt <= now() || item.state === "consumed")
        return send(res, 410, { status: "expired" });
      if (item.state === "denied") {
        item.state = "consumed";
        return send(res, 403, { status: "denied" });
      }
      if (item.state !== "approved") return send(res, 202, { status: "pending" });
      item.state = "consumed";
      const user = item.user;
      const access = opaque();
      const session = {
        user,
        revoked: false,
        blocked: false,
        expiresAt:
          now() + (body.supportsRefresh === true ? 3_600_000 : 5 * 365 * 24 * 60 * 60 * 1000),
        refreshToken: null,
      };
      sessions.set(access, session);
      if (body.supportsRefresh === true) {
        session.refreshToken = opaque();
        refreshes.set(session.refreshToken, session);
        return send(res, 200, {
          status: "approved",
          token: access,
          refreshToken: session.refreshToken,
          expiresIn: 3600,
          userId: user.id,
          userEmail: user.email,
        });
      }
      return send(res, 200, {
        status: "approved",
        token: access,
        expiresIn: 5 * 365 * 24 * 60 * 60,
        userId: user.id,
        userEmail: user.email,
      });
    }
    if (req.method === "POST" && url.pathname === "/api/auth/native/refresh") {
      const previous = refreshes.get(body?.refreshToken);
      if (!previous) {
        const reused = retiredRefreshes.get(body?.refreshToken);
        if (reused) reused.revoked = true;
        return send(res, 401, { error: reused ? "SESSION_REVOKED" : "INVALID_REFRESH_TOKEN" });
      }
      if (previous.revoked) return send(res, 401, { error: "SESSION_REVOKED" });
      if (previous.blocked) return send(res, 401, { error: "USER_BLOCKED" });
      refreshes.delete(body.refreshToken);
      retiredRefreshes.set(body.refreshToken, previous);
      for (const [accessToken, active] of sessions)
        if (active === previous) sessions.delete(accessToken);
      const next = opaque();
      previous.refreshToken = next;
      previous.expiresAt = now() + 3_600_000;
      refreshes.set(next, previous);
      const access = opaque();
      sessions.set(access, previous);
      return send(res, 200, { token: access, refreshToken: next, expiresIn: 3600 });
    }
    if (req.method === "GET" && url.pathname === "/api/profile") {
      const auth = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
      const session = auth && sessions.get(auth[1]);
      if (!session || session.revoked || session.expiresAt <= now())
        return send(res, 401, { error: "unauthorized" });
      const { id, email, name, organizations = [] } = session.user;
      return send(res, 200, {
        user: { id, email, name, image: null },
        ...(organizations.length ? { organizations } : {}),
        hasPersonalAccount: true,
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
    async approve(userCode, user) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/__fake/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userCode, user }),
      });
      return response.ok;
    },
    async deny(userCode) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/__fake/deny`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userCode }),
      });
      return response.ok;
    },
    revoke(userId) {
      for (const session of new Set(sessions.values()))
        if (session.user.id === userId) session.revoked = true;
    },
    block(userId) {
      for (const session of new Set(sessions.values()))
        if (session.user.id === userId) session.blocked = true;
    },
    requests() {
      return requests.map((request) => ({ ...request }));
    },
    close() {
      return new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
