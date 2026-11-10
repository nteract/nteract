// Synthetic whoami responses for the isolated E2E bundle only. No real IdP I/O.
export const fixtureWhoamiUrl = "https://pages-e2e.invalid/api/auth/sessions/whoami";

export function generateFixtureKeys() {
  const keys = {},
    responses = {};
  const encode = (value) =>
    btoa(JSON.stringify(value)).replaceAll("=", "").replaceAll("+", "-").replaceAll("/", "_");
  for (const [name, email, scopes] of [
    ["owner", "dev@localhost", ["cloud:read", "cloud:write"]],
    ["editor", "alice@localhost", ["cloud:read", "cloud:write"]],
    ["reader", "alice@localhost", ["cloud:read"]],
    ["viewer", "bob@localhost", ["cloud:read", "cloud:write"]],
    ["unscoped", "alice@localhost", []],
    ["employee", "employee@anaconda.com", ["cloud:read", "cloud:write"]],
    ["blockedEmployee", "blocked@anaconda.com", ["cloud:read", "cloud:write"]],
    ["consumer", "outsider@gmail.com", ["cloud:read", "cloud:write"]],
  ]) {
    // Deliberately untrusted JWT claims. The actual production validator must
    // obtain the account and scopes from whoami, not from this token payload.
    const token = `${encode({ alg: "RS256" })}.${encode({ ver: "api:1", sub: "forged-owner", jti: crypto.randomUUID() })}.fixture`;
    keys[name] = token;
    responses[token] = {
      passport: {
        user_id: email,
        source: "api_key",
        scopes,
        profile: { first_name: name, last_name: "Fixture", email },
      },
    };
  }
  return { keys, responses };
}

export function fixtureFetch(origin, responses, realFetch) {
  const expected = new URL(origin);
  if (
    expected.protocol !== "http:" ||
    expected.hostname !== "localhost" ||
    expected.origin !== origin
  )
    throw new Error("E2E fixture requires a bare localhost HTTP origin");
  return async (input, init) => {
    const request = new Request(input, init);
    if (request.url === fixtureWhoamiUrl) {
      const key = request.headers.get("authorization")?.replace(/^Bearer /, "");
      return Object.hasOwn(responses, key)
        ? Response.json(responses[key])
        : Response.json({ error: "Unknown synthetic key" }, { status: 401 });
    }
    if (new URL(request.url).origin !== origin)
      throw new Error("E2E fixture forbids external network requests");
    return realFetch(input, init);
  };
}
