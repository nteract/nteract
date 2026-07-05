// @vitest-environment node
// This package is host-free web-standard code with no DOM needs. The node
// environment keeps jose's WebCrypto and Uint8Array in one realm; the repo's
// default jsdom environment splits them and breaks JWT signing.
import { describe, expect, it } from "vitest";
import * as jose from "jose";
import { createLocalOidcIssuer, type LocalOidcIssuer, type LocalOidcOptions } from "../src/index";

const ISSUER_URL = "http://localhost:9911/local-oidc";
const CLIENT_ID = "local-oidc-client";
const REDIRECT_URI = "http://localhost:5173/oidc";

function makeIssuer(overrides: Partial<LocalOidcOptions> = {}): LocalOidcIssuer {
  return createLocalOidcIssuer({
    issuerUrl: ISSUER_URL,
    users: [{ email: "dev@localhost", givenName: "Local", familyName: "Developer" }],
    ...overrides,
  });
}

function expectResponse(response: Response | null): Response {
  if (response === null) {
    throw new Error("expected the issuer to handle this request");
  }
  return response;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readJson(response: Response): Promise<any> {
  return JSON.parse(await response.text());
}

async function verifierFor(
  issuer: LocalOidcIssuer,
): Promise<ReturnType<typeof jose.createLocalJWKSet>> {
  return jose.createLocalJWKSet(await issuer.jwks());
}

function tokenRequest(fields: Record<string, string>): Request {
  return new Request(`${ISSUER_URL}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
}

async function authorizeCode(issuer: LocalOidcIssuer): Promise<string> {
  const url = new URL(`${ISSUER_URL}/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  const response = expectResponse(await issuer.handle(new Request(url)));
  const location = new URL(response.headers.get("location") ?? "");
  const code = location.searchParams.get("code");
  if (!code) {
    throw new Error("authorize did not return a code");
  }
  return code;
}

async function exchange(issuer: LocalOidcIssuer): Promise<Record<string, string>> {
  const code = await authorizeCode(issuer);
  const response = expectResponse(
    await issuer.handle(
      tokenRequest({
        grant_type: "authorization_code",
        code,
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
      }),
    ),
  );
  return readJson(response);
}

describe("createLocalOidcIssuer", () => {
  it("serves a discovery document that points at its own endpoints", async () => {
    const issuer = makeIssuer();
    const response = expectResponse(
      await issuer.handle(new Request(`${ISSUER_URL}/.well-known/openid-configuration`)),
    );
    expect(response.status).toBe(200);
    const doc = await readJson(response);
    expect(doc.issuer).toBe(ISSUER_URL);
    expect(doc.jwks_uri).toBe(`${ISSUER_URL}/.well-known/jwks.json`);
    expect(doc.authorization_endpoint).toBe(`${ISSUER_URL}/authorize`);
    expect(doc.token_endpoint).toBe(`${ISSUER_URL}/token`);
    expect(doc.userinfo_endpoint).toBe(`${ISSUER_URL}/userinfo`);
    expect(doc.response_types_supported).toContain("code");
    expect(doc.id_token_signing_alg_values_supported).toContain("RS256");
  });

  it("returns null for paths outside the issuer mount", async () => {
    const issuer = makeIssuer();
    const response = await issuer.handle(new Request("http://localhost:9911/somewhere/else"));
    expect(response).toBeNull();
  });

  it("publishes a single RS256 signing key in its JWKS", async () => {
    const issuer = makeIssuer();
    const response = expectResponse(
      await issuer.handle(new Request(`${ISSUER_URL}/.well-known/jwks.json`)),
    );
    expect(response.status).toBe(200);
    const jwks = await readJson(response);
    expect(jwks.keys).toHaveLength(1);
    const [key] = jwks.keys;
    expect(key.kty).toBe("RSA");
    expect(key.alg).toBe("RS256");
    expect(key.use).toBe("sig");
    expect(typeof key.kid).toBe("string");
    // The public JWKS must never leak private key material.
    expect(key.d).toBeUndefined();
  });

  it("auto-grants the dev user through authorize, code, and token exchange", async () => {
    const issuer = makeIssuer();
    const url = new URL(`${ISSUER_URL}/authorize`);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", CLIENT_ID);
    url.searchParams.set("redirect_uri", REDIRECT_URI);
    url.searchParams.set("state", "xyz");

    const authorizeResponse = expectResponse(await issuer.handle(new Request(url)));
    expect(authorizeResponse.status).toBe(302);
    const location = new URL(authorizeResponse.headers.get("location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(REDIRECT_URI);
    expect(location.searchParams.get("state")).toBe("xyz");
    const code = location.searchParams.get("code");
    expect(code).toBeTruthy();

    const tokenResponse = expectResponse(
      await issuer.handle(
        tokenRequest({
          grant_type: "authorization_code",
          code: code ?? "",
          client_id: CLIENT_ID,
          redirect_uri: REDIRECT_URI,
        }),
      ),
    );
    expect(tokenResponse.status).toBe(200);
    const tokens = await readJson(tokenResponse);
    expect(tokens.token_type).toBe("Bearer");
    expect(typeof tokens.access_token).toBe("string");
    expect(typeof tokens.id_token).toBe("string");
    expect(typeof tokens.refresh_token).toBe("string");

    const { payload, protectedHeader } = await jose.jwtVerify(
      tokens.access_token,
      await verifierFor(issuer),
      { issuer: ISSUER_URL, audience: CLIENT_ID },
    );
    expect(protectedHeader.alg).toBe("RS256");
    expect(payload.iss).toBe(ISSUER_URL);
    expect(payload.aud).toBe(CLIENT_ID);
    expect(payload.email).toBe("dev@localhost");
    expect(payload.sub).toBe("dev@localhost");
    expect(payload.given_name).toBe("Local");
    expect(payload.name).toBe("Local Developer");
  });

  it("returns profile claims from userinfo for a valid access token", async () => {
    const issuer = makeIssuer();
    const tokens = await exchange(issuer);
    const response = expectResponse(
      await issuer.handle(
        new Request(`${ISSUER_URL}/userinfo`, {
          headers: { authorization: `Bearer ${tokens.access_token}` },
        }),
      ),
    );
    expect(response.status).toBe(200);
    const info = await readJson(response);
    expect(info.sub).toBe("dev@localhost");
    expect(info.email).toBe("dev@localhost");
    expect(info.given_name).toBe("Local");
  });

  it("rejects userinfo without a bearer token", async () => {
    const issuer = makeIssuer();
    const response = expectResponse(await issuer.handle(new Request(`${ISSUER_URL}/userinfo`)));
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
  });

  it("mints short-lived tokens that a verifier rejects once they lapse", async () => {
    const issuer = makeIssuer({ defaultTokenTtlSeconds: 1 });
    const token = await issuer.mintToken({ sub: "dev@localhost", email: "dev@localhost" });
    const verify = await verifierFor(issuer);

    await expect(
      jose.jwtVerify(token, verify, { issuer: ISSUER_URL, audience: CLIENT_ID }),
    ).resolves.toBeDefined();

    await expect(
      jose.jwtVerify(token, verify, {
        issuer: ISSUER_URL,
        audience: CLIENT_ID,
        currentDate: new Date(Date.now() + 5000),
      }),
    ).rejects.toMatchObject({ code: "ERR_JWT_EXPIRED" });
  });

  it("honors a per-call ttl override in mintToken", async () => {
    const issuer = makeIssuer({ defaultTokenTtlSeconds: 3600 });
    const token = await issuer.mintToken({ sub: "svc", email: "svc@localhost" }, { ttlSeconds: 1 });
    const { payload } = await jose.jwtVerify(token, await verifierFor(issuer), {
      issuer: ISSUER_URL,
      audience: CLIENT_ID,
    });
    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(1);
  });

  it("mintToken signs a token that verifies against the published JWKS", async () => {
    const issuer = makeIssuer();
    const token = await issuer.mintToken({
      sub: "svc",
      email: "svc@localhost",
      scope: "cloud:write",
    });
    const { payload, protectedHeader } = await jose.jwtVerify(token, await verifierFor(issuer), {
      issuer: ISSUER_URL,
      audience: CLIENT_ID,
    });
    const jwks = await issuer.jwks();
    expect(protectedHeader.kid).toBe(jwks.keys[0].kid);
    expect(payload.iss).toBe(ISSUER_URL);
    expect(payload.aud).toBe(CLIENT_ID);
    expect(payload.scope).toBe("cloud:write");
  });

  it("re-mints tokens through the refresh_token grant", async () => {
    const issuer = makeIssuer();
    const first = await exchange(issuer);
    const response = expectResponse(
      await issuer.handle(
        tokenRequest({
          grant_type: "refresh_token",
          refresh_token: first.refresh_token,
          client_id: CLIENT_ID,
        }),
      ),
    );
    expect(response.status).toBe(200);
    const next = await readJson(response);
    expect(typeof next.access_token).toBe("string");
    const { payload } = await jose.jwtVerify(next.access_token, await verifierFor(issuer), {
      issuer: ISSUER_URL,
      audience: CLIENT_ID,
    });
    expect(payload.email).toBe("dev@localhost");
  });

  it("generates a fresh signing key per issuer instance", async () => {
    const first = await makeIssuer().jwks();
    const second = await makeIssuer().jwks();
    expect(first.keys[0].kid).not.toBe(second.keys[0].kid);
  });

  it("rejects a non-loopback redirect_uri at authorize", async () => {
    const issuer = makeIssuer();
    const url = new URL(`${ISSUER_URL}/authorize`);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", CLIENT_ID);
    url.searchParams.set("redirect_uri", "https://evil.example.com/callback");
    const response = expectResponse(await issuer.handle(new Request(url)));
    expect(response.status).toBe(400);
  });

  it("rejects an unknown client_id at authorize", async () => {
    const issuer = makeIssuer();
    const url = new URL(`${ISSUER_URL}/authorize`);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", "someone-else");
    url.searchParams.set("redirect_uri", REDIRECT_URI);
    const response = expectResponse(await issuer.handle(new Request(url)));
    expect(response.status).toBe(400);
  });

  it("selects a configured user by login_hint", async () => {
    const issuer = makeIssuer({
      users: [{ email: "first@localhost" }, { email: "second@localhost", givenName: "Second" }],
    });
    const url = new URL(`${ISSUER_URL}/authorize`);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", CLIENT_ID);
    url.searchParams.set("redirect_uri", REDIRECT_URI);
    url.searchParams.set("login_hint", "second@localhost");
    const authorizeResponse = expectResponse(await issuer.handle(new Request(url)));
    const code = new URL(authorizeResponse.headers.get("location") ?? "").searchParams.get("code");

    const tokenResponse = expectResponse(
      await issuer.handle(
        tokenRequest({
          grant_type: "authorization_code",
          code: code ?? "",
          client_id: CLIENT_ID,
          redirect_uri: REDIRECT_URI,
        }),
      ),
    );
    const tokens = await readJson(tokenResponse);
    const { payload } = await jose.jwtVerify(tokens.access_token, await verifierFor(issuer), {
      issuer: ISSUER_URL,
      audience: CLIENT_ID,
    });
    expect(payload.email).toBe("second@localhost");
  });
});
