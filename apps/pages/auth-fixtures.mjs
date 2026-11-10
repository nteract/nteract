// Entirely generated/local fixtures. No production credentials or provider calls.
export async function createAuthFixture() {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const publicKey = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  const now = Math.floor(Date.now() / 1000);
  const issuer = "https://oidc-fixture.invalid";
  const clientId = "authenticated-automerge-spike";
  const whoamiUrl = "https://anaconda-fixture.invalid/api/auth/sessions/whoami";
  const nonce = crypto.randomUUID();
  const subject = "fixture-user";
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const apiResponses = new Map();
  return {
    nonce,
    subject,
    now,
    env: {
      NOTEBOOK_CLOUD_OIDC_ISSUER: issuer,
      NOTEBOOK_CLOUD_OIDC_CLIENT_ID: clientId,
      NOTEBOOK_CLOUD_OIDC_JWKS_JSON: JSON.stringify({
        keys: [{ ...publicKey, kid: "fixture", alg: "RS256", use: "sig" }],
      }),
      // Explicitly configured same subject domain. Without these they differ.
      NOTEBOOK_CLOUD_OIDC_PRINCIPAL_NAMESPACE: "user:anaconda-fixture",
      NOTEBOOK_CLOUD_ANACONDA_API_KEY_PRINCIPAL_NAMESPACE: "user:anaconda-fixture",
      NOTEBOOK_CLOUD_ANACONDA_API_KEY_USERINFO_URL: whoamiUrl,
    },
    async sign(claims = {}) {
      const payload = {
        iss: issuer,
        aud: clientId,
        sub: subject,
        iat: now,
        exp: now + 300,
        nonce,
        name: "Fixture Person",
        ...claims,
      };
      const input = `${encode({ alg: "RS256", kid: "fixture", typ: "JWT" })}.${encode(payload)}`;
      const signature = await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        keyPair.privateKey,
        new TextEncoder().encode(input),
      );
      return `${input}.${Buffer.from(signature).toString("base64url")}`;
    },
    apiKey({
      scopes = ["cloud:read", "cloud:write"],
      source = "api_key",
      userId = subject,
      claimedSubject = "untrusted-token-subject",
      status = 200,
    } = {}) {
      // This deliberately is not signed. Provider whoami, not unverified token
      // claims, establishes API-key identity in the real production validator.
      const token = `${encode({ alg: "RS256" })}.${encode({ ver: "api:1", sub: claimedSubject, name: "Untrusted name", jti: crypto.randomUUID() })}.fixture`;
      apiResponses.set(token, {
        status,
        body: {
          passport: {
            user_id: userId,
            source,
            scopes,
            profile: {
              first_name: "Fixture",
              last_name: "Person",
              email: "fixture@example.invalid",
            },
          },
        },
      });
      return token;
    },
    async fetch(url, options) {
      if (String(url) !== whoamiUrl)
        throw new Error(`Unexpected network access in fixture: ${url}`);
      const token = new Headers(options?.headers).get("Authorization")?.replace(/^Bearer /, "");
      const response = apiResponses.get(token);
      if (!response) throw new Error("Unknown fixture API key");
      return Response.json(response.body, { status: response.status });
    },
  };
}
