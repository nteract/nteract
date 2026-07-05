# @nteract/local-oidc

Dev-only OIDC issuer as a host-free package. It mints RS256 tokens for a
configured dev user so a local cloud shell can run the real OIDC verification
path without a live IdP.

This is a development identity source. The authorize endpoint auto-grants the
configured dev user with no login challenge, so any caller that reaches it walks
away with a valid token. Never mount it without an explicit dev gate. A
production host must route auth to a real IdP.

The signing key is ephemeral: it is generated per issuer instance (per boot) and
never persisted, so every restart rotates the keys.

## Usage

```ts
import { createLocalOidcIssuer } from "@nteract/local-oidc";

const issuer = createLocalOidcIssuer({
  issuerUrl: "https://localhost:8787/local-oidc",
  clientId: "local-oidc-client",
  defaultTokenTtlSeconds: 60,
  users: [{ email: "dev@localhost", givenName: "Local", familyName: "Developer" }],
});

// In a dev-gated router, fall through when the path is not ours:
const response = await issuer.handle(request);
if (response) return response;
```

`handle(request)` serves the discovery document, JWKS, authorize, token,
userinfo, and end-session endpoints under the issuer mount path, and returns
`null` for anything outside it. `mintToken(claims, { ttlSeconds })` signs a token
directly, and `jwks()` returns the public key set for verification.

The issuer only depends on web-standard `Request`/`Response`/`URL`/WebCrypto
(via `jose`), so the same handler runs under Workers, Deno, Bun, or a Node fetch
server.
