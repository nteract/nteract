// D1-backed state for the loopback test issuer (`@nteract/local-oidc`).
//
// celld can run more than one gateway isolate, and the browser's authorize
// request and the callback's token exchange can land in different ones. Every
// isolate reads codes and the signing key from D1, so a code issued in one
// redeems in another and every isolate signs and publishes the same key.
//
// The gateway mounts this only for NOTEBOOK_CLOUD_LOCAL_OIDC on a loopback
// host. Production sign-in uses a real IdP and never reaches this module.
//
// The key row lasts as long as the D1 database. E2E runs start from an empty
// database; `npm run dev` keeps its key across restarts with the rest of its
// state.
import { isolateSetup } from "./isolate-setup.mjs";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS local_oidc_codes (
    code TEXT PRIMARY KEY, entry_json TEXT NOT NULL, expires_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS local_oidc_codes_expiry ON local_oidc_codes(expires_at)`,
  `CREATE TABLE IF NOT EXISTS local_oidc_keys (id TEXT PRIMARY KEY, private_jwk TEXT NOT NULL)`,
];
const KEY_ID = "signing";

// Concurrent requests never await one another's schema setup; see isolate-setup.mjs.
const schemaReady = isolateSetup((db) => db.batch(SCHEMA.map((sql) => db.prepare(sql))));
const stores = new WeakMap();

/** The local issuer store for one D1 binding, or undefined without one. */
export function localOidcStore(db) {
  if (!db?.prepare || !db.batch) return undefined;
  let store = stores.get(db);
  if (!store) {
    store = d1LocalOidcStore(db);
    stores.set(db, store);
  }
  return store;
}

function d1LocalOidcStore(db) {
  const readKey = async () => {
    const row = await db
      .prepare("SELECT private_jwk FROM local_oidc_keys WHERE id = ?")
      .bind(KEY_ID)
      .first();
    return row ? JSON.parse(row.private_jwk) : undefined;
  };
  return {
    async putAuthorizationCode(code, entry) {
      await schemaReady(db);
      const { expiresAt, ...grant } = entry;
      await db.batch([
        db.prepare("DELETE FROM local_oidc_codes WHERE expires_at <= ?").bind(Date.now()),
        db
          .prepare("INSERT INTO local_oidc_codes (code, entry_json, expires_at) VALUES (?, ?, ?)")
          .bind(code, JSON.stringify(grant), expiresAt),
      ]);
    },
    // One DELETE ... RETURNING statement, so of two concurrent redemptions only
    // one gets the row back.
    async takeAuthorizationCode(code) {
      await schemaReady(db);
      const row = await db
        .prepare("DELETE FROM local_oidc_codes WHERE code = ? RETURNING entry_json, expires_at")
        .bind(code)
        .first();
      return row ? { ...JSON.parse(row.entry_json), expiresAt: row.expires_at } : undefined;
    },
    // The first key inserted wins; an isolate that loses the race reads it back.
    async signingKey(generate) {
      await schemaReady(db);
      const existing = await readKey();
      if (existing) return existing;
      await db
        .prepare("INSERT OR IGNORE INTO local_oidc_keys (id, private_jwk) VALUES (?, ?)")
        .bind(KEY_ID, JSON.stringify(await generate()))
        .run();
      const saved = await readKey();
      if (!saved) throw new Error("local OIDC signing key was not saved");
      return saved;
    },
  };
}
