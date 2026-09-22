import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  directoryCallerEmail,
  parsePeopleDirectory,
  PeopleDirectoryConfigurationError,
  resolveDirectoryPerson,
  searchPeopleDirectory,
} from "../src/people-directory.ts";
import type { Env } from "../src/cloudflare-types.ts";
import type { AuthenticatedConnection } from "../src/identity.ts";

const bob = {
  id: "54dd56fb-68fb-4361-bba9-033aee41b2a7",
  email: "bob@example.com",
  displayName: "Bob Example",
};
const other = {
  id: "536013b1-1ed1-4726-b44c-5bf7843f936d",
  email: "bob@other.example",
  displayName: "Bob Elsewhere",
};
const roster = JSON.stringify({
  allowedDomains: [" Example.COM ", "other.example"],
  people: [bob, other],
});

describe("explicit people directory", () => {
  it("is absent by default and refuses wildcard, suffix, malformed, or duplicated roster entries", () => {
    assert.equal(parsePeopleDirectory(undefined), null);
    assert.deepEqual(searchPeopleDirectory(null, "alice@example.com", "bo"), {
      directoryEnabled: false,
      people: [],
    });
    for (const value of [
      "not json",
      JSON.stringify({ allowedDomains: ["*.example.com"], people: [bob] }),
      JSON.stringify({ allowedDomains: ["example.com."], people: [bob] }),
      JSON.stringify({ allowedDomains: ["example.com"], people: [other] }),
      JSON.stringify({ allowedDomains: ["example.com"], people: [bob, bob] }),
      JSON.stringify({ allowedDomains: ["example.com"], people: [{ ...bob, id: bob.email }] }),
      JSON.stringify({
        allowedDomains: ["example.com"],
        people: [{ ...bob, avatarUrl: "javascript:alert(1)" }],
      }),
      " ".repeat(128 * 1024) + roster,
    ]) {
      assert.throws(() => parsePeopleDirectory(value), PeopleDirectoryConfigurationError);
    }
  });

  it("isolates allowed domains from each other and denies subdomain/suffix lookalikes", () => {
    const directory = parsePeopleDirectory(roster);
    assert.deepEqual(searchPeopleDirectory(directory, "ALICE@EXAMPLE.COM", "bob"), {
      directoryEnabled: true,
      people: [{ id: bob.id, displayName: bob.displayName, avatarUrl: null, source: "directory" }],
    });
    for (const caller of [
      null,
      "alice@sub.example.com",
      "alice@example.com.evil.test",
      "alice@notexample.com",
      "alice@example.com.",
    ]) {
      assert.deepEqual(searchPeopleDirectory(directory, caller, "bo"), {
        directoryEnabled: false,
        people: [],
      });
      assert.equal(resolveDirectoryPerson(directory, caller, bob.id), null);
    }
    assert.equal(resolveDirectoryPerson(directory, "alice@example.com", other.id), null);
    assert.equal(resolveDirectoryPerson(directory, bob.email, bob.id), null);
  });

  it("returns bounded name-prefix matches without emails, wildcard searches, or a full roster", () => {
    const people = Array.from({ length: 25 }, (_, index) => ({
      ...bob,
      id: `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
      email: `bob${index}@example.com`,
      displayName: `Bob ${index}`,
    }));
    const directory = parsePeopleDirectory(
      JSON.stringify({ allowedDomains: ["example.com"], people }),
    );
    for (const query of ["", "b", "*", "%", "_", "x".repeat(81)]) {
      assert.deepEqual(searchPeopleDirectory(directory, "alice@example.com", query).people, []);
    }
    const result = searchPeopleDirectory(directory, "alice@example.com", "bo");
    assert.equal(result.people.length, 10);
    assert.equal(JSON.stringify(result).includes("@"), false);
    assert.deepEqual(Object.keys(result.people[0]).sort(), [
      "avatarUrl",
      "displayName",
      "id",
      "source",
    ]);
  });

  it("supports people before login and removes selected IDs immediately with roster removal", () => {
    const directory = parsePeopleDirectory(roster);
    assert.equal(resolveDirectoryPerson(directory, "alice@example.com", bob.id)?.email, bob.email);
    const removed = parsePeopleDirectory(
      JSON.stringify({ allowedDomains: ["example.com"], people: [] }),
    );
    assert.deepEqual(searchPeopleDirectory(removed, "alice@example.com", "bob").people, []);
    assert.equal(resolveDirectoryPerson(removed, "alice@example.com", bob.id), null);
  });

  it("only accepts current verified provider email, never dev identity or an unverified claim", async () => {
    const env: Env = {
      NOTEBOOK_ROOMS: {
        idFromName: (name) => ({ toString: () => name }),
        get: () => ({ fetch: async () => new Response() }),
      },
    };
    const identity: AuthenticatedConnection = {
      principal: "user:oidc:alice",
      operator: "browser:tab",
      actorLabel: "user:oidc:alice/browser:tab",
      scope: "owner",
      metadata: {
        provider: "oidc",
        transport: "oidc-bearer",
        principalNamespace: "user:oidc",
        email: "Alice@Example.com",
        emailVerified: true,
      },
    };
    assert.equal(await directoryCallerEmail(env, identity), "alice@example.com");
    assert.equal(
      await directoryCallerEmail(env, {
        ...identity,
        metadata: { ...identity.metadata, emailVerified: false },
      }),
      null,
    );
    assert.equal(
      await directoryCallerEmail(env, {
        ...identity,
        metadata: { ...identity.metadata, provider: "dev" },
      }),
      null,
    );
  });
});
