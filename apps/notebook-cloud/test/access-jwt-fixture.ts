export interface AccessTokenFixture {
  env: {
    NOTEBOOK_CLOUD_ACCESS_AUD: string;
    NOTEBOOK_CLOUD_ACCESS_JWKS_JSON: string;
    NOTEBOOK_CLOUD_ACCESS_TEAM_DOMAIN: string;
  };
  token: string;
}

export interface OidcTokenFixture {
  env: {
    NOTEBOOK_CLOUD_OIDC_CLIENT_ID: string;
    NOTEBOOK_CLOUD_OIDC_ISSUER: string;
    NOTEBOOK_CLOUD_OIDC_JWKS_JSON: string;
    NOTEBOOK_CLOUD_OIDC_PRINCIPAL_NAMESPACE: string;
  };
  token: string;
}

interface TokenFixtureOptions {
  algorithm?: string;
  audience?: string | string[];
  authorizedParty?: string;
  email?: string;
  excludeMatchingKey?: boolean;
  expiresInSeconds?: number;
  includeKid?: boolean;
  includeMalformedKey?: boolean;
  includeUnmatchedKey?: boolean;
  matchingKeyOps?: JsonWebKey["key_ops"];
  matchingKeyUse?: JsonWebKey["use"] | null;
  name?: string;
  notBeforeSecondsFromNow?: number;
  subject?: string | null;
  tokenIssuer?: string | null;
}

export async function accessTokenFixture(
  options: TokenFixtureOptions,
): Promise<AccessTokenFixture> {
  const issuer = "https://team.cloudflareaccess.com";
  const audience = "notebook-cloud-aud";
  const { jwksJson, token } = await signedTokenFixture({
    ...options,
    audience: options.audience ?? audience,
    issuer,
  });

  return {
    env: {
      NOTEBOOK_CLOUD_ACCESS_AUD: audience,
      NOTEBOOK_CLOUD_ACCESS_JWKS_JSON: jwksJson,
      NOTEBOOK_CLOUD_ACCESS_TEAM_DOMAIN: issuer,
    },
    token,
  };
}

export async function oidcTokenFixture(options: TokenFixtureOptions): Promise<OidcTokenFixture> {
  const issuer = "https://auth.stage.anaconda.com/api/auth";
  const clientId = "notebook-cloud-oidc-client";
  const { jwksJson, token } = await signedTokenFixture({
    ...options,
    audience: options.audience ?? clientId,
    issuer,
  });

  return {
    env: {
      NOTEBOOK_CLOUD_OIDC_CLIENT_ID: clientId,
      NOTEBOOK_CLOUD_OIDC_ISSUER: issuer,
      NOTEBOOK_CLOUD_OIDC_JWKS_JSON: jwksJson,
      NOTEBOOK_CLOUD_OIDC_PRINCIPAL_NAMESPACE: "user:anaconda",
    },
    token,
  };
}

async function signedTokenFixture(
  options: TokenFixtureOptions & { audience: string | string[]; issuer: string },
): Promise<{ jwksJson: string; token: string }> {
  const kid = "test-key";
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
  const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  const unmatchedPublicJwk = options.includeUnmatchedKey
    ? await crypto.subtle.exportKey(
        "jwk",
        (
          await crypto.subtle.generateKey(
            {
              name: "RSASSA-PKCS1-v1_5",
              modulusLength: 2048,
              publicExponent: new Uint8Array([1, 0, 1]),
              hash: "SHA-256",
            },
            true,
            ["sign", "verify"],
          )
        ).publicKey,
      )
    : null;
  const now = Math.floor(Date.now() / 1000);
  const header = {
    alg: options.algorithm ?? "RS256",
    ...(options.includeKid === false ? {} : { kid }),
    typ: "JWT",
  };
  const payload = {
    aud: options.audience,
    ...(options.authorizedParty ? { azp: options.authorizedParty } : {}),
    ...(options.email ? { email: options.email } : {}),
    exp: now + (options.expiresInSeconds ?? 300),
    ...(options.tokenIssuer === null ? {} : { iss: options.tokenIssuer ?? options.issuer }),
    ...(options.name ? { name: options.name } : {}),
    ...(typeof options.notBeforeSecondsFromNow === "number"
      ? { nbf: now + options.notBeforeSecondsFromNow }
      : {}),
    ...(options.subject ? { sub: options.subject } : {}),
  };
  const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    keyPair.privateKey,
    new TextEncoder().encode(signingInput),
  );

  return {
    jwksJson: JSON.stringify({
      keys: [
        ...(options.includeMalformedKey ? [{ alg: "RS256", kty: "RSA", use: "sig" }] : []),
        ...(unmatchedPublicJwk
          ? [{ ...unmatchedPublicJwk, alg: "RS256", kid: "unmatched", use: "sig" }]
          : []),
        ...(options.excludeMatchingKey
          ? []
          : [
              {
                ...publicJwk,
                alg: "RS256",
                kid,
                ...(options.matchingKeyUse === null
                  ? {}
                  : { use: options.matchingKeyUse ?? "sig" }),
                ...(options.matchingKeyOps ? { key_ops: options.matchingKeyOps } : {}),
              },
            ]),
      ],
    }),
    token: `${signingInput}.${base64UrlBytes(new Uint8Array(signature))}`,
  };
}

export function base64Url(value: string): string {
  return base64UrlBytes(new TextEncoder().encode(value));
}

function base64UrlBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
