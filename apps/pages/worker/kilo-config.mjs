/** A deployment's Kilo sign-in settings and the Pages identity a Kilo account
 * stands for. The browser sign-in (kilo-handoff.mjs) and the agent token
 * (kilo-token.mjs) both read them here, so a person is the same principal
 * whichever way they arrive. */

const MIN_SECRET_LENGTH = 32;
// A name Kilo can hold for a deployment, such as `pages-dev`.
const AUDIENCE = /^\S{1,200}$/;

/** This deployment's Kilo sign-in settings, or null when it doesn't use Kilo.
 * `PAGES_KILO_APP_URL` turns it on and must be a bare `https:` origin; a
 * loopback `http:` origin is accepted only beside the local test issuer flag.
 * `PAGES_KILO_AUDIENCE` is the name Kilo holds this deployment under, and
 * `PAGES_KILO_EXCHANGE_SECRET` is what Kilo checks at the exchange. A set but
 * unusable value, or a missing audience or secret, throws, so a misconfigured
 * deployment fails loudly and never falls back to another sign-in. */
export function kiloSignIn(env, request) {
  const configured = env?.PAGES_KILO_APP_URL;
  if (!configured) return null;
  let app;
  try {
    app = new URL(String(configured));
  } catch {
    throw new Error("Kilo sign-in is misconfigured");
  }
  const loopback =
    app.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(app.hostname) &&
    env.NOTEBOOK_CLOUD_LOCAL_OIDC === "true";
  const audience = env.PAGES_KILO_AUDIENCE;
  const secret = env.PAGES_KILO_EXCHANGE_SECRET;
  if (
    (app.protocol !== "https:" && !loopback) ||
    String(configured).replace(/\/$/, "") !== app.origin ||
    app.username ||
    app.password ||
    typeof audience !== "string" ||
    !AUDIENCE.test(audience) ||
    typeof secret !== "string" ||
    secret.length < MIN_SECRET_LENGTH
  )
    throw new Error("Kilo sign-in is misconfigured");
  return {
    appUrl: app.origin,
    audience,
    origin: new URL(env.NOTEBOOK_CLOUD_PUBLIC_ORIGIN || request.url).origin,
    namespace: env.PAGES_KILO_PRINCIPAL_NAMESPACE?.trim() || "user:kilo",
    secret,
  };
}

/** The identity a Kilo account stands for: its id and, when it has one, its
 * name. */
export function kiloIdentity(config, account) {
  const principal = `${config.namespace}:${encodeURIComponent(account.id)}`;
  return {
    principal,
    operator: "browser",
    actorLabel: `${principal}/browser`,
    scope: "owner",
    metadata: {
      // The session label every server session carries (app-session.ts).
      provider: "oidc",
      transport: "host-session-cookie",
      principalNamespace: config.namespace,
      ...(account.name ? { displayName: account.name } : {}),
    },
  };
}
