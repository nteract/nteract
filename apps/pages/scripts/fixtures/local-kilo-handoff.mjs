// Node-only loopback fake of the two Kilo routes Pages signs in through
// (worker/kilo-exchange.mjs): the page a browser is sent to, and the
// exchange of a code or an agent token. It holds a list of Pages deployments
// by audience, issues codes that expire and are good only for the audience
// and state they were issued for, mints agent tokens signed with a key only it
// holds, and checks the exchange secret. Like Kilo's, a code is not single
// use, and the exchange body is strict: a code with its audience and state,
// or a token with its audience.
//
// An account is `{ id, name, email?, verifiedEmail?, blocked? }`. The answer
// carries `verified_email` only for an account given `verifiedEmail`, as Kilo
// sends it only with proof the account controls the address, and the value
// is sent as given so a test can send one Pages can't use. `email` stands for
// an address Kilo holds without that proof; it is sent as `email`, a key
// Pages doesn't read.
//
// With `memberSearch`, every exchange answer also carries
// `member_search_proof`, and `POST /api/pages-auth/organization-members`
// answers as Kilo's does: on the secret and a proof minted for that searcher
// and audience within 8 hours, it searches or resolves the members of one of
// the searcher's organizations. Members are every account the fake knows,
// signed in or given a token, plus `members(organizationId, list)`. Without
// `memberSearch` the answer has no proof and the route is missing, like a Kilo
// from before the route.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const CODE_SECONDS = 60;
const PROOF_SECONDS = 8 * 60 * 60;
const MEMBER_LIMIT = 10;
const send = (res, status, value) =>
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
const userOf = (account) => ({
  id: account.id,
  name: account.name,
  email: account.email,
  ...(Object.hasOwn(account, "verifiedEmail") && { verified_email: account.verifiedEmail }),
});

/** Starts the fake. `deployments` maps each audience to the Pages origin it
 * redirects to and `secret` is what the exchange requires. `signIn(account)`
 * sets who the browser is at Kilo, or nobody with `null`; `respond(fn)`
 * replaces the next exchange answer with `fn(req, res)`. An account's
 * `organizations` (`[{ id, name, role }]`) is what each exchange that names
 * it reports, read when the exchange runs. */
export async function startLocalKiloHandoff({
  deployments,
  secret,
  port = 0,
  now = Date.now,
  memberSearch = false,
}) {
  const codes = new Map();
  const exchanges = [];
  // Accounts Kilo can mint an agent token for, by id, and the key it signs
  // them with. Pages never sees the key.
  const accounts = new Map();
  const signingKey = randomBytes(32);
  const sign = (text) => createHmac("sha256", signingKey).update(text).digest("base64url");
  const verifyToken = (token) => {
    const parts = typeof token === "string" ? token.split(".") : [];
    if (parts.length !== 3) return null;
    const expected = Buffer.from(sign(`${parts[0]}.${parts[1]}`));
    const given = Buffer.from(parts[2]);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    try {
      return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    } catch {
      return null;
    }
  };
  let account = null;
  let override = null;
  let membersOverride = null;
  const memberCalls = [];
  // Members `members()` added, by organization id: `[{ id, name, image_url }]`.
  const directory = new Map();
  const proofFor = (userId, audience) => {
    const payload = Buffer.from(
      JSON.stringify({ purpose: "pages-member-search", userId, audience, iat: now() }),
    ).toString("base64url");
    return `${payload}.${sign(`proof.${payload}`)}`;
  };
  const verifyProof = (proof, userId, audience) => {
    const [payload, signature, extra] = typeof proof === "string" ? proof.split(".") : [];
    if (!payload || !signature || extra !== undefined) return false;
    const expected = Buffer.from(sign(`proof.${payload}`));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return false;
    try {
      const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
      return (
        claims.purpose === "pages-member-search" &&
        claims.userId === userId &&
        claims.audience === audience &&
        now() - claims.iat < PROOF_SECONDS * 1000
      );
    } catch {
      return false;
    }
  };
  // Kilo's answer for an account: identity, organizations and, with member
  // search, the proof. The account becomes searchable by its organizations.
  const answerFor = (holder, audience) => {
    accounts.set(holder.id, holder);
    return {
      user: userOf(holder),
      organizations: holder.organizations ?? [],
      ...(memberSearch && { member_search_proof: proofFor(holder.id, audience) }),
    };
  };
  const membersOf = (organizationId) => {
    const found = new Map();
    for (const holder of accounts.values())
      if (!holder.blocked && holder.organizations?.some(({ id }) => id === organizationId))
        found.set(holder.id, { id: holder.id, name: holder.name, image_url: null });
    for (const member of directory.get(organizationId) ?? []) found.set(member.id, member);
    return [...found.values()]
      .filter(({ name }) => typeof name === "string" && name.trim() && !/[@\uFF20]/u.test(name))
      .sort((a, b) => a.name.localeCompare(b.name));
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/pages-auth") {
      const audience = url.searchParams.get("audience");
      const state = url.searchParams.get("state");
      if (!audience || !Object.hasOwn(deployments, audience) || !state)
        return send(res, 400, { error: "bad_request" });
      // The real page sends a browser without a session to sign in first.
      if (!account) return send(res, 401, { error: "signed_out" });
      const code = randomBytes(32).toString("base64url");
      codes.set(code, { audience, state, account, expiresAt: now() + CODE_SECONDS * 1000 });
      const callback = new URL("/api/auth/kilo/callback", deployments[audience]);
      callback.search = new URLSearchParams({ code, state }).toString();
      return res.writeHead(302, { location: callback.href }).end();
    }
    if (req.method === "POST" && url.pathname === "/api/pages-auth/exchange") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        return send(res, 400, { error: "bad_json" });
      }
      exchanges.push(
        body && typeof body === "object" && "token" in body
          ? {
              authorization: req.headers.authorization,
              fields: Object.keys(body).sort(),
              audience: body.audience,
              token: body.token,
            }
          : {
              authorization: req.headers.authorization,
              audience: body?.audience,
              state: body?.state,
            },
      );
      if (override) {
        const answer = override;
        override = null;
        return answer(req, res);
      }
      if (
        !body ||
        typeof body !== "object" ||
        typeof body.audience !== "string" ||
        "token" in body === "code" in body ||
        Object.keys(body).some(
          (key) =>
            !("token" in body ? ["token", "audience"] : ["code", "audience", "state"]).includes(
              key,
            ),
        )
      )
        return send(res, 400, { error: "invalid_request" });
      if (
        req.headers.authorization !== `Bearer ${secret}` ||
        !Object.hasOwn(deployments, body.audience)
      )
        return send(res, 401, { error: "invalid_client" });
      if ("token" in body) {
        const claims = verifyToken(body.token);
        if (!claims || claims.aud !== body.audience || claims.exp * 1000 <= now())
          return send(res, 400, { error: "invalid_token" });
        const holder = accounts.get(claims.kiloUserId);
        if (!holder || holder.blocked) return send(res, 403, { error: "account_unavailable" });
        return send(res, 200, answerFor(holder, body.audience));
      }
      const issued = codes.get(body?.code);
      if (
        !issued ||
        issued.audience !== body.audience ||
        issued.state !== body.state ||
        issued.expiresAt <= now()
      )
        return send(res, 400, { error: "invalid_code" });
      if (issued.account.blocked) return send(res, 403, { error: "account_unavailable" });
      return send(res, 200, answerFor(issued.account, body.audience));
    }
    if (
      memberSearch &&
      req.method === "POST" &&
      url.pathname === "/api/pages-auth/organization-members"
    ) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        body = null;
      }
      memberCalls.push({
        authorization: req.headers.authorization,
        fields: body && typeof body === "object" ? Object.keys(body).sort() : [],
        searcher_id: body?.searcher_id,
        organization_id: body?.organization_id,
        query: body?.query,
        member_id: body?.member_id,
        proof: body?.proof,
      });
      if (membersOverride) {
        const answer = membersOverride;
        membersOverride = null;
        return answer(req, res);
      }
      const common = ["audience", "searcher_id", "organization_id", "proof"];
      const query = typeof body?.query === "string" ? body.query.trim() : null;
      if (
        !body ||
        typeof body !== "object" ||
        common.some((key) => typeof body[key] !== "string" || !body[key]) ||
        "query" in body === "member_id" in body ||
        Object.keys(body).some((key) => ![...common, "query", "member_id"].includes(key)) ||
        ("query" in body && (query === null || query.length < 2 || query.length > 100)) ||
        ("member_id" in body && (typeof body.member_id !== "string" || !body.member_id))
      )
        return send(res, 400, { error: "invalid_request" });
      if (
        req.headers.authorization !== `Bearer ${secret}` ||
        !Object.hasOwn(deployments, body.audience)
      )
        return send(res, 401, { error: "invalid_client" });
      if (!verifyProof(body.proof, body.searcher_id, body.audience))
        return send(res, 401, { error: "invalid_proof" });
      const searcher = accounts.get(body.searcher_id);
      if (
        !searcher ||
        searcher.blocked ||
        !searcher.organizations?.some(({ id }) => id === body.organization_id)
      )
        return send(res, 403, { error: "not_a_member" });
      const members = membersOf(body.organization_id);
      if ("member_id" in body)
        return send(res, 200, { members: members.filter(({ id }) => id === body.member_id) });
      const prefix = query.toLowerCase();
      return send(res, 200, {
        members: members
          .filter(({ name }) =>
            name
              .toLowerCase()
              .split(/\s+/u)
              .some((word) => word.startsWith(prefix)),
          )
          .slice(0, MEMBER_LIMIT),
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
    /** What Kilo's `POST /api/auth/resource-token` gives an agent of `holder`:
     * an HS256 token for `audience`, live for `seconds`. `claims` overrides
     * any claim. Later calls with the same id replace the account, so a test
     * can block it. */
    mintToken(holder, { audience, seconds = 300, claims = {} } = {}) {
      accounts.set(holder.id, holder);
      const issuedAt = Math.floor(now() / 1000);
      const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
      const unsigned = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
        version: 1,
        kiloUserId: holder.id,
        env: "test",
        aud: audience,
        iat: issuedAt,
        exp: issuedAt + seconds,
        tokenPurpose: "delegated-workload",
        credentialExchange: false,
        ...claims,
      })}`;
      return `${unsigned}.${sign(unsigned)}`;
    },
    block(id) {
      const holder = accounts.get(id);
      if (holder) accounts.set(id, { ...holder, blocked: true });
    },
    respond(answer) {
      override = answer;
    },
    /** Adds members to an organization's directory, beside the accounts the
     * fake already knows: `[{ id, name, image_url? }]`. */
    members(organizationId, list) {
      directory.set(organizationId, [
        ...(directory.get(organizationId) ?? []),
        ...list.map(({ id, name, image_url = null }) => ({ id, name, image_url })),
      ]);
    },
    /** Replaces the next member search answer with `fn(req, res)`. */
    respondMembers(answer) {
      membersOverride = answer;
    },
    /** A proof as the exchange would mint it now, for a test to send. */
    proofFor,
    memberCalls: () => memberCalls.slice(),
    exchanges: () => exchanges.slice(),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
}
