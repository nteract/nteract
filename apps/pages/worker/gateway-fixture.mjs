// A worker gateway with a browser session (cookie) and an API key (bearer)
// for one account, over one Page host.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createServerAppSession } from "@cloud/app-session.ts";
import {
  oidcDatabase,
  randomSecret,
  SERVER_SESSION_COOKIE,
  serverSessionContext,
  serverSessionId,
} from "@cloud/oidc-session-store.ts";
import { createAuthFixture } from "../auth-fixtures.mjs";
import { Page } from "./index.mjs";
import { DocumentPolicy } from "./policy.mjs";
import { plainStub } from "./plain-stub.mjs";

export const pageId = "33333333-3333-4333-8333-333333333333";
export const publicOrigin = "https://page10.runtimed.run";
export const privateOrigin = "http://127.0.0.1:9475";

export async function gatewayFixture(t) {
  const auth = await createAuthFixture();
  t.mock.method(globalThis, "fetch", auth.fetch);
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  const env = {
    ...auth.env,
    NOTEBOOK_CLOUD_PUBLIC_ORIGIN: publicOrigin,
    NOTEBOOK_CLOUD_APP_SESSION_SECRET: "fixture-only-session-secret-".repeat(2),
    DB: {
      prepare(sql) {
        const statement = sqlite.prepare(sql);
        let bindings = [];
        return {
          bind(...values) {
            bindings = values;
            return this;
          },
          async first() {
            return statement.get(...bindings) ?? null;
          },
          async run() {
            statement.run(...bindings);
            return { success: true };
          },
        };
      },
    },
  };
  await oidcDatabase(env);
  const principal = `user:anaconda-fixture:${auth.subject}`;
  const token = randomSecret();
  const now = Math.floor(Date.now() / 1000);
  const session = await createServerAppSession(
    env,
    {
      principal,
      metadata: {
        provider: "oidc",
        principalNamespace: "user:anaconda-fixture",
        displayName: "Fixture Person",
      },
    },
    "fixture-session",
    now + 300,
    now,
  );
  sqlite
    .prepare(`INSERT INTO oidc_server_sessions
    (id, context, session_json, sealed, access_expires_at, idle_expires_at, absolute_expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(
      await serverSessionId(env, token),
      serverSessionContext(env, publicOrigin),
      JSON.stringify(session),
      "unused-for-session-read",
      now + 300,
      now + 300,
      now + 300,
    );
  const page = Object.assign(Object.create(Page.prototype), {
    plain: plainStub(),
    env,
    ready: Promise.resolve(),
    tail: Promise.resolve(),
    metadata: { pageId, owner: principal, ownerName: "Fixture Person", deleted: false },
    async installAccess(metadata) {
      this.metadata = metadata;
    },
  });
  page.policy = new DocumentPolicy({ metadata: () => page.metadata });
  const forwarded = [];
  env.PAGES = {
    getByName(id) {
      assert.equal(id, pageId);
      return {
        fetch(request) {
          forwarded.push(request.clone());
          return page.fetch(request);
        },
      };
    },
  };
  return {
    env,
    page,
    forwarded,
    cookie: `${SERVER_SESSION_COOKIE}=${token}`,
    bearer: `Bearer ${auth.apiKey()}`,
    request({ method = "GET", headers = {}, body } = {}) {
      return new Request(`${privateOrigin}/api/access?page=${pageId}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    },
  };
}
