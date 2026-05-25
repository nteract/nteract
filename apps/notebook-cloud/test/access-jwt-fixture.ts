export interface AccessTokenFixture {
  env: {
    NOTEBOOK_CLOUD_ACCESS_AUD: string;
    NOTEBOOK_CLOUD_ACCESS_JWKS_JSON: string;
    NOTEBOOK_CLOUD_ACCESS_TEAM_DOMAIN: string;
  };
  token: string;
}

export async function accessTokenFixture(options: {
  audience?: string;
  email?: string;
  includeKid?: boolean;
  includeMalformedKey?: boolean;
  includeUnmatchedKey?: boolean;
  matchingKeyOps?: JsonWebKey["key_ops"];
  matchingKeyUse?: JsonWebKey["use"] | null;
  name?: string;
  subject: string;
}): Promise<AccessTokenFixture> {
  const issuer = "https://team.cloudflareaccess.com";
  const audience = "notebook-cloud-aud";
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
    alg: "RS256",
    ...(options.includeKid === false ? {} : { kid }),
    typ: "JWT",
  };
  const payload = {
    aud: options.audience ?? audience,
    ...(options.email ? { email: options.email } : {}),
    exp: now + 300,
    iss: issuer,
    ...(options.name ? { name: options.name } : {}),
    sub: options.subject,
  };
  const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    keyPair.privateKey,
    new TextEncoder().encode(signingInput),
  );

  return {
    env: {
      NOTEBOOK_CLOUD_ACCESS_AUD: audience,
      NOTEBOOK_CLOUD_ACCESS_JWKS_JSON: JSON.stringify({
        keys: [
          ...(options.includeMalformedKey ? [{ alg: "RS256", kty: "RSA", use: "sig" }] : []),
          ...(unmatchedPublicJwk
            ? [{ ...unmatchedPublicJwk, alg: "RS256", kid: "unmatched", use: "sig" }]
            : []),
          {
            ...publicJwk,
            alg: "RS256",
            kid,
            ...(options.matchingKeyUse === null ? {} : { use: options.matchingKeyUse ?? "sig" }),
            ...(options.matchingKeyOps ? { key_ops: options.matchingKeyOps } : {}),
          },
        ],
      }),
      NOTEBOOK_CLOUD_ACCESS_TEAM_DOMAIN: issuer,
    },
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
