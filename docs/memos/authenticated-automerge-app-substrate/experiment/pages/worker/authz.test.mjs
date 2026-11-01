import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CAPABILITIES, OBJECT_CAPABILITIES, decide } from "./authz.mjs";

const authzDirectory = fileURLToPath(new URL("../authz/", import.meta.url));
const fixtures = JSON.parse(readFileSync(join(authzDirectory, "fixtures.json"), "utf8"));
const schema = readFileSync(join(authzDirectory, "schema.zed"), "utf8");

/** `type:id` or `type:id#relation` */
function reference(text) {
  const [object, relation] = text.split("#");
  const [type, id] = object.split(":");
  return { type, id, ...(relation && { relation }) };
}
function tuple(text) {
  const [resource, subject] = text.split("@");
  const { type, id, relation } = reference(resource);
  return { resource: { type, id }, relation, subject: reference(subject) };
}
const subjectRef = ({ type, id }) => ({ type, id });

/**
 * The relation copy a host would lease, built from a case's tuples: the
 * object's relations, its project's relations, and each principal's
 * organization and group memberships with their lease expiry.
 */
function leasedCopy(fixture, { leases = true } = {}) {
  const tuples = fixture.relationships.map(tuple);
  const target = reference(fixture.object);
  const relationsOf = (type, id) => {
    const relations = {};
    for (const entry of tuples)
      if (entry.resource.type === type && entry.resource.id === id)
        (relations[entry.relation] ??= []).push(subjectRef(entry.subject));
    return relations;
  };
  const relations = relationsOf(target.type, target.id);
  const project = relations.project?.[0];
  const object = {
    type: target.type,
    id: target.id,
    revision: fixture.revision,
    lifecycle: fixture.lifecycle,
    relations,
    container: project
      ? {
          type: "project",
          id: project.id,
          revision: 0,
          relations: relationsOf("project", project.id),
          ...(leases &&
            fixture.container_valid_until !== undefined && {
              valid_until: fixture.container_valid_until,
            }),
        }
      : null,
  };
  const memberships = (subject) =>
    tuples
      .filter(
        (entry) =>
          ["organization", "group"].includes(entry.resource.type) &&
          entry.relation === "member" &&
          entry.subject.type === "user" &&
          entry.subject.id === subject.id,
      )
      .map((entry) => ({
        type: entry.resource.type,
        id: entry.resource.id,
        expires_at: fixtures.now + fixtures.membership_lease_ms,
      }));
  return { object, memberships };
}

function principalFor(entry, memberships, { write = entry.credential === "write" } = {}) {
  const subject = reference(entry.subject);
  return {
    id: subject.id,
    expires_at: fixtures.now + fixtures.credential_ms,
    can_write: write,
    memberships: [
      ...memberships(subject),
      ...(entry.expired_memberships ?? []).map((text) => ({
        ...reference(text),
        expires_at: fixtures.now - 1,
      })),
    ],
  };
}

test("every fixture case decides as recorded", () => {
  let rows = 0;
  for (const fixture of fixtures.cases) {
    const { object, memberships } = leasedCopy(fixture);
    for (const entry of fixture.principals) {
      rows++;
      const label = `${fixture.name}: ${entry.subject} (${entry.credential})`;
      const decision = decide(
        principalFor(entry, memberships),
        entry.actor_chain ?? [],
        object,
        fixtures.now,
      );
      assert.deepEqual(decision.capabilities, entry.capabilities, label);
      assert.equal(decision.revision, fixture.revision, label);
      assert.equal(decision.authority_token, null, label);
      if (entry.basis) assert.deepEqual(decision.basis, entry.basis, label);
      if (entry.valid_until !== undefined)
        assert.equal(decision.valid_until, entry.valid_until, label);
      if (!entry.capabilities.length) assert.equal(decision.valid_until, null, label);
    }
  }
  assert.ok(rows >= 40, `fixture table has ${rows} rows`);
});

test("fixture cases cover the required shapes", () => {
  const names = fixtures.cases.map((fixture) => fixture.name).join("\n");
  for (const required of [
    /owner/,
    /editor/,
    /viewer/,
    /project roles/,
    /direct/,
    /company view/,
    /Trash/,
    /deleted/,
    /tombstone/,
    /group/,
    /agent/,
  ])
    assert.match(names, required);
  const subjects = fixtures.cases.flatMap((fixture) => fixture.principals);
  assert.ok(
    subjects.some((entry) => entry.subject === "user:mallory" && !entry.capabilities.length),
  );
  for (const fixture of fixtures.cases)
    for (const entry of fixture.principals)
      for (const capability of entry.capabilities)
        assert.ok(OBJECT_CAPABILITIES[reference(fixture.object).type].includes(capability));
});

test("decide() is pure: the actor chain never widens and the input is unchanged", () => {
  const fixture = fixtures.cases.find((entry) => entry.object === "page:company");
  const { object, memberships } = leasedCopy(fixture);
  const before = structuredClone(object);
  const principal = principalFor({ subject: "user:dana", credential: "write" }, memberships);
  const plain = decide(principal, [], object, fixtures.now);
  assert.deepEqual(decide(principal, ["agent:kilo", "agent:other"], object, fixtures.now), plain);
  assert.deepEqual(decide(principal, [], object, fixtures.now), plain);
  assert.deepEqual(object, before);
  // At the membership lease's expiry the decision has lapsed.
  assert.deepEqual(decide(principal, [], object, plain.valid_until).capabilities, []);
});

test("decide() fails closed on credentials and objects it can't read", () => {
  const object = leasedCopy(fixtures.cases[0]).object;
  const alice = { id: "alice", expires_at: fixtures.now + 1, can_write: true, memberships: [] };
  assert.equal(decide(alice, [], object, fixtures.now).capabilities.length, 11);
  for (const principal of [
    undefined,
    { ...alice, id: undefined },
    { ...alice, expires_at: fixtures.now },
    { ...alice, expires_at: Number.NaN },
  ])
    assert.deepEqual(decide(principal, [], object, fixtures.now).capabilities, []);
  for (const unreadable of [
    undefined,
    { ...object, type: "notebook" },
    { ...object, lifecycle: "missing" },
  ])
    assert.deepEqual(decide(alice, [], unreadable, fixtures.now).capabilities, []);
  // A membership without a lease never counts.
  const company = leasedCopy(
    fixtures.cases.find((entry) => entry.object === "page:company"),
  ).object;
  const unleased = {
    id: "dana",
    expires_at: fixtures.now + 1,
    can_write: true,
    memberships: [{ type: "organization", id: "anaconda" }],
  };
  assert.deepEqual(decide(unleased, [], company, fixtures.now).capabilities, []);
});

// ---------------------------------------------------------------------------
// schema.zed

/** definition name { relation r: ...; permission p = ... } without comments. */
function parseSchema(text) {
  const stripped = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const definitions = {};
  for (const match of stripped.matchAll(/definition\s+([a-z_][a-z0-9_/]*)\s*\{([^}]*)\}/g)) {
    const body = match[2];
    definitions[match[1]] = {
      relations: Object.fromEntries(
        [...body.matchAll(/relation\s+([a-z_][a-z0-9_]*)\s*:\s*([^\n]+)/g)].map((entry) => [
          entry[1],
          entry[2].split("|").map((type) => type.trim()),
        ]),
      ),
      permissions: Object.fromEntries(
        [...body.matchAll(/permission\s+([a-z_][a-z0-9_]*)\s*=\s*([^\n]+)/g)].map((entry) => [
          entry[1],
          entry[2].trim(),
        ]),
      ),
    };
  }
  return definitions;
}

test("schema.zed declares the model decide() implements", () => {
  const definitions = parseSchema(schema);
  assert.deepEqual(Object.keys(definitions).sort(), [
    "group",
    "organization",
    "page",
    "project",
    "user",
  ]);
  assert.deepEqual(Object.keys(definitions.organization.relations).sort(), ["admin", "member"]);
  assert.deepEqual(definitions.group.relations, { member: ["user"] });
  const shared = ["user", "group#member", "organization#member"];
  for (const type of ["project", "page"]) {
    const { relations, permissions } = definitions[type];
    assert.deepEqual(relations.org, ["organization"]);
    assert.deepEqual(relations.owner, ["user"]);
    assert.deepEqual(relations.editor, shared);
    assert.deepEqual(relations.viewer, shared);
    const capabilities = Object.keys(permissions).filter((name) => CAPABILITIES.includes(name));
    assert.deepEqual(capabilities.sort(), [...OBJECT_CAPABILITIES[type]].sort(), type);
  }
  assert.deepEqual(definitions.page.relations.project, ["project"]);
  assert.deepEqual(definitions.page.relations.removed, ["user"]);
  assert.deepEqual(definitions.page.relations.commenter, ["user", "group#member"]);
  // The proposal's rewrites.
  const { project, page } = definitions;
  assert.equal(project.permissions.contribute, "owner + editor");
  assert.equal(project.permissions.read_items, "contribute + viewer");
  assert.equal(page.permissions.administer, "owner + project->administer");
  assert.equal(page.permissions.edit, "administer + editor + project->contribute");
  assert.equal(page.permissions.comment, "edit + commenter");
  assert.equal(page.permissions.read, "comment + (viewer - removed) + project->read_items");
  assert.equal(page.permissions.share, "administer");
  assert.match(schema, /either a `project` or an `owner`, never both/);
});

/** A zed validation file: schema, relationships and assertions. */
function validationFile(schemaText, relationships, assertTrue, assertFalse) {
  const block = (text) =>
    text
      .split("\n")
      .map((line) => (line ? `  ${line}` : ""))
      .join("\n");
  const list = (items) =>
    items.length ? items.map((item) => `\n    - ${JSON.stringify(item)}`).join("") : " []";
  return [
    `schema: |-\n${block(schemaText.trimEnd())}`,
    `relationships: |-\n${block(relationships.join("\n"))}`,
    `assertions:\n  assertTrue:${list(assertTrue)}\n  assertFalse:${list(assertFalse)}`,
    "",
  ].join("\n");
}

const zedAvailable = spawnSync("zed", ["version"], { encoding: "utf8" }).status === 0;

test(
  "SpiceDB computes the same relation decisions as decide() on every fixture",
  { skip: !zedAvailable && "zed is not installed; schema.zed was only parsed structurally" },
  (t) => {
    const directory = mkdtempSync(join(tmpdir(), "pages-authz-"));
    try {
      const files = [];
      let assertions = 0;
      for (const [index, fixture] of fixtures.cases.entries()) {
        if (fixture.spicedb) continue;
        // SpiceDB sees relations only: no lifecycle overlay, no credential
        // ceiling, no lease on the project copy. decide() answers the same
        // question with an active lifecycle and a write credential.
        const { object, memberships } = leasedCopy(fixture, { leases: false });
        const active = { ...object, lifecycle: "active" };
        const assertTrue = [];
        const assertFalse = [];
        const type = reference(fixture.object).type;
        for (const entry of fixture.principals) {
          const relationDecision = decide(
            principalFor(entry, memberships, { write: true }),
            [],
            active,
            fixtures.now,
          ).capabilities;
          for (const capability of OBJECT_CAPABILITIES[type])
            (relationDecision.includes(capability) ? assertTrue : assertFalse).push(
              `${fixture.object}#${capability}@${entry.subject}`,
            );
        }
        assertions += assertTrue.length + assertFalse.length;
        const file = join(directory, `case-${index}.yaml`);
        writeFileSync(
          file,
          validationFile(
            schema,
            fixture.relationships,
            [...new Set(assertTrue)],
            [...new Set(assertFalse)],
          ),
        );
        files.push(file);
      }
      const result = spawnSync("zed", ["validate", "--fail-on-warn", ...files], {
        encoding: "utf8",
      });
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      t.diagnostic(`zed validate: ${files.length} cases, ${assertions} assertions`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
