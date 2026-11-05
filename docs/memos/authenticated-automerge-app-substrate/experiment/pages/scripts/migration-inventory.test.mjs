import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import * as A from "@automerge/automerge";
import { cbor, documentIdToBinary, interpretAsDocumentId } from "@automerge/automerge-repo";
import { sedimentreeId } from "@automerge/automerge-repo/sedimentree";
import { DocStore, MemoryByteStore } from "../sync/doc-store.mjs";
import { commentsDocUuid, commentsDocumentId } from "../worker/comments-store.mjs";
import { logicalId } from "../worker/policy.mjs";
import { auditInventory, LIMITS, resultState, SCHEMA } from "./migration-inventory.mjs";

const id = (n) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const encode = (v) => Buffer.from(cbor.encode(v)).toString("base64");
const audit = (e) => auditInventory(JSON.stringify(e));
async function fixture(n = 1, schema) {
  const pageId = id(n);
  const documentId = interpretAsDocumentId(
    Uint8Array.from({ length: 16 }, (_, i) => (i === 15 ? n : 0)),
  );
  const commentsUuid = await commentsDocUuid(pageId);
  const trees = [documentId, commentsDocumentId(commentsUuid)].map((d) =>
    sedimentreeId(documentIdToBinary(d)),
  );
  const bytes = new MemoryByteStore();
  const store = new DocStore(bytes);
  const known = [];
  for (const [i, tree] of trees.entries()) {
    let doc = A.from(
      i ? { threads: {} } : { page_id: pageId, title: "Synthetic only", blocks: {} },
    );
    if (schema)
      doc = A.change(doc, (d) => {
        d.schema = schema;
      });
    await store.compact(tree, A.save(doc), A.getHeads(doc));
    known.push(A.getHeads(doc));
    doc = A.change(doc, (d) => {
      d.test_marker = "increment";
    });
    await store.append(tree, A.getLastLocalChange(doc), A.getHeads(doc));
    A.free(doc);
  }
  const plain = [];
  for (const key of await bytes.list(""))
    plain.push([`plain/${key}`, Buffer.from(await bytes.load(key)).toString("base64")]);
  return {
    schema: SCHEMA,
    source: {
      kind: "offline-extract",
      target: "synthetic",
      capture_id: "fixture-only",
      source_sha: "f".repeat(40),
    },
    catalogs: [{ account: "synthetic-owner", entries: [[`page/${pageId}`, { page_id: pageId }]] }],
    hosts: [
      {
        page_id: pageId,
        record: {
          pageId,
          owner: "synthetic-owner",
          documentId,
          tree: logicalId(documentIdToBinary(documentId)),
          comments_doc: commentsUuid,
          deleted: false,
          recordStorage: "automerge",
        },
        creation: null,
        pending_keys: [],
        plain,
        known_heads: { page: known[0], comments: known[1] },
      },
    ],
  };
}
function mutateManifest(e, fn, suffix = "m2") {
  const entry = e.hosts[0].plain.find(([key]) => key.endsWith(`/${suffix}`));
  const value = cbor.decode(Buffer.from(entry[1], "base64"));
  fn(value, entry);
  entry[1] = encode(value);
}

test("result state is monotone for every state/event pair", () => {
  for (const state of ["ready", "incomplete", "blocked"])
    for (const event of ["verified", "missing", "invalid"])
      assert.equal(
        resultState(state, event),
        state === "blocked" || event === "invalid"
          ? "blocked"
          : state === "incomplete" || event === "missing"
            ? "incomplete"
            : "ready",
      );
  assert.throws(() => resultState("unknown", "verified"));
  assert.throws(() => resultState("ready", "other"));
});

test("duplicate JSON properties, including escaped names, are not silently discarded", async () => {
  for (const input of [
    '{"schema":"bad","schema":"pages-migration-evidence-v1","catalogs":[],"hosts":[]}',
    '{"schema":"pages-migration-evidence-v1","catalogs":[],"hosts":[],"extra":{"a":1,"\\u0061":2}}',
  ]) {
    const result = await auditInventory(input);
    assert.equal(result.state, "blocked");
    assert.ok(result.issues.includes("duplicate_json_key"));
  }
});

test("real DocStore snapshot+increment verifies both documents and prior heads without mutation", async () => {
  const e = await fixture();
  const before = JSON.stringify(e);
  const result = await audit(e);
  assert.equal(result.state, "ready", JSON.stringify(result));
  assert.equal(result.pages[0].classification, "plain_verified");
  assert.equal(result.pages[0].documents.comments.state, "ready");
  assert.equal(result.global_state, "incomplete");
  assert.equal(result.removal_ready, false);
  assert.equal(JSON.stringify(e), before);
});

test("rejected storage selectors never reach report output", async (t) => {
  for (const value of [
    "sensitive_placeholder",
    { body: "sensitive_placeholder", token: "sensitive_placeholder" },
  ])
    await t.test(typeof value, async () => {
      const e = await fixture();
      e.hosts[0].record.recordStorage = value;
      const result = await audit(e);
      assert.equal(result.state, "blocked");
      assert.equal(JSON.stringify(result).includes("sensitive_placeholder"), false);
      assert.equal(Object.hasOwn(result.pages[0], "record_storage"), false);
    });
});

test("per-row verification requires provenance and nonempty independent heads for both documents", async (t) => {
  for (const [name, change] of [
    [
      "missing provenance",
      (e) => {
        delete e.source;
      },
    ],
    [
      "malformed provenance",
      (e) => {
        e.source.target = { token: "sensitive_placeholder" };
      },
    ],
    [
      "coerced provenance hash",
      (e) => {
        e.source.source_sha = [e.source.source_sha];
      },
    ],
    [
      "missing heads",
      (e) => {
        delete e.hosts[0].known_heads;
      },
    ],
    [
      "empty heads",
      (e) => {
        e.hosts[0].known_heads = { page: [], comments: [] };
      },
    ],
    [
      "missing page heads",
      (e) => {
        delete e.hosts[0].known_heads.page;
      },
    ],
    [
      "empty comment heads",
      (e) => {
        e.hosts[0].known_heads.comments = [];
      },
    ],
  ])
    await t.test(name, async () => {
      const e = await fixture();
      change(e);
      const result = await audit(e);
      assert.equal(result.state, "incomplete");
      assert.equal(result.pages[0].state, "incomplete");
      assert.equal(result.pages[0].classification, "unknown");
      assert.equal(result.counts.plain_verified ?? 0, 0);
      assert.equal(result.counts.unknown, 1);
      assert.equal(JSON.stringify(result).includes("sensitive_placeholder"), false);
    });
});

test("malformed independent heads and coercible output IDs are rejected", async (t) => {
  for (const [name, change] of [
    [
      "null heads",
      (e) => {
        e.hosts[0].known_heads.page = null;
      },
    ],
    [
      "object heads",
      (e) => {
        e.hosts[0].known_heads.comments = { token: "sensitive_placeholder" };
      },
    ],
    [
      "coerced host ID",
      (e) => {
        e.hosts[0].page_id = [e.hosts[0].page_id];
      },
    ],
  ])
    await t.test(name, async () => {
      const e = await fixture();
      change(e);
      const result = await audit(e);
      assert.equal(result.state, "blocked");
      assert.equal(result.counts.plain_verified ?? 0, 0);
      assert.equal(JSON.stringify(result).includes("sensitive_placeholder"), false);
    });
});

test("legacy inline manifests verify; m2 takes precedence over stale legacy", async () => {
  const e = await fixture();
  for (const entry of e.hosts[0].plain.filter(([key]) => key.endsWith("/m2"))) {
    const m = cbor.decode(Buffer.from(entry[1], "base64"));
    const prefix = entry[0].slice(0, -2);
    m.chunks = [
      cbor.decode(Buffer.from(e.hosts[0].plain.find(([k]) => k === `${prefix}c/2`)[1], "base64")),
    ];
    delete m.version;
    entry[0] = `${prefix}m`;
    entry[1] = encode(m);
  }
  assert.equal((await audit(e)).state, "ready");
  const fresh = await fixture();
  fresh.hosts[0].plain.push([
    fresh.hosts[0].plain.find(([k]) => k.endsWith("/m2"))[0].slice(0, -1),
    encode({ version: 99 }),
  ]);
  assert.equal((await audit(fresh)).state, "ready");
});

test("missing provenance, forged coverage, known heads, and empty subsets never establish completeness", async (t) => {
  for (const [name, change] of [
    [
      "provenance",
      (e) => {
        delete e.source;
      },
    ],
    [
      "coverage",
      (e) => {
        e.coverage = { all_accounts: true, native_registration_closed: true };
      },
    ],
    [
      "known-heads",
      (e) => {
        delete e.hosts[0].known_heads;
      },
    ],
    [
      "empty",
      (e) => {
        e.catalogs = [];
        e.hosts = [];
      },
    ],
    [
      "missing-host",
      (e) => {
        e.hosts = [];
      },
    ],
    [
      "missing-catalog",
      (e) => {
        e.catalogs = [];
      },
    ],
  ])
    await t.test(name, async () => {
      const e = await fixture();
      change(e);
      const result = await audit(e);
      assert.equal(result.state, "incomplete");
      assert.equal(result.removal_ready, false);
    });
});

test("all observed accounts, Project content, nested, trash and host-only Pages are retained", async () => {
  const first = await fixture(1);
  const second = await fixture(2);
  second.hosts[0].record.owner = "other-owner";
  second.hosts[0].record.deleted = true;
  second.hosts[0].record.trash = { trashed_at: "2026-01-01T00:00:00.000Z" };
  first.catalogs[0].entries.push(["space/synthetic-project", { document_id: id(1) }]);
  first.catalogs.push({
    account: "other-owner",
    entries: [[`trash/${id(2)}`, { page_id: id(2), parent_id: id(3) }]],
  });
  first.hosts.push(second.hosts[0]);
  const result = await audit(first);
  assert.equal(result.accounts_observed, 2);
  assert.equal(result.pages.length, 3);
  assert.ok(result.pages.find((p) => p.page_id === id(1)).catalog.includes("content"));
  assert.equal(result.pages.find((p) => p.page_id === id(2)).classification, "plain_verified");
  assert.equal(result.pages.find((p) => p.page_id === id(3)).classification, "unknown");
  assert.equal(result.state, "incomplete");
  assert.ok(!result.issues.includes("project_content_unmigrated"));
});

test("a space record from before the content migration is retained and reported, never guessed", async () => {
  // Pre-migration evidence names the content document with the retired field.
  const legacy = await fixture(1);
  legacy.catalogs[0].entries.push(["space/old-project", { home_page_id: id(1) }]);
  const result = await audit(legacy);
  assert.equal(result.pages.length, 1);
  assert.deepEqual(result.pages[0].catalog.sort(), ["active", "legacy_content"]);
  assert.ok(result.issues.includes("project_content_unmigrated"));
  assert.equal(result.state, "incomplete");
  assert.equal(result.removal_ready, false);
  // A record naming both fields, or neither, is not a Project record.
  for (const value of [{ document_id: id(1), home_page_id: id(1) }, {}, { title: "x" }]) {
    const broken = await fixture(1);
    broken.catalogs[0].entries.push(["space/broken", value]);
    const refused = await audit(broken);
    assert.equal(refused.state, "blocked", JSON.stringify(value));
    assert.ok(refused.issues.includes("invalid_project"), JSON.stringify(value));
  }
});

test("native selectors, pending creation/registration/journals and deletion fail closed", async (t) => {
  for (const mode of [undefined, "local", "buffered"])
    await t.test(`native-${mode}`, async () => {
      const e = await fixture();
      e.hosts[0].record.recordStorage = mode;
      assert.equal((await audit(e)).pages[0].classification, "unmigrated");
    });
  for (const kind of ["creation", "registration", "journal", "catalog"])
    await t.test(kind, async () => {
      const e = await fixture();
      if (kind === "journal") e.hosts[0].pending_keys = ["host/operation/synthetic"];
      else if (kind === "catalog") e.catalogs[0].entries[0][1].pending = true;
      else {
        e.hosts[0].creation = {
          metadata: {
            ...e.hosts[0].record,
            ...(kind === "registration" ? { registration: "synthetic" } : {}),
          },
        };
        e.hosts[0].record = null;
      }
      const result = await audit(e);
      assert.equal(result.pages[0].classification, "pending");
      assert.equal(result.state, "incomplete");
    });
  const deleted = await fixture();
  deleted.hosts[0].record.deleted = true;
  deleted.catalogs[0].entries = [[`host/deleted/${id(1)}`, true]];
  let result = await audit(deleted);
  assert.equal(result.pages[0].classification, "deleted");
  assert.equal(result.pages[0].cleanup, "required");
  deleted.hosts[0].plain = [];
  result = await audit(deleted);
  assert.equal(result.pages[0].cleanup, "unknown");
  assert.equal(result.state, "incomplete");
});

test("missing comments, descriptors, object parts remain incomplete", async (t) => {
  for (const [name, remove] of [
    [
      "comments",
      (entries) =>
        entries.filter(
          ([k]) => !k.includes(entries.filter(([k]) => k.endsWith("m2"))[1][0].slice(0, -2)),
        ),
    ],
    ["descriptor", (entries) => entries.filter(([k]) => !k.endsWith("c/2"))],
    ["part", (entries) => entries.filter(([k]) => !k.endsWith("o/1/0"))],
  ])
    await t.test(name, async () => {
      const e = await fixture();
      e.hosts[0].plain = remove(e.hosts[0].plain);
      const result = await audit(e);
      assert.equal(result.state, "incomplete");
      assert.notEqual(result.pages[0].classification, "plain_verified");
    });
});

test("document feature mismatch and cross-Page selectors block; comments fallback is deterministic", async () => {
  assert.equal((await audit(await fixture(1, { features: ["future-feature"] }))).state, "blocked");
  const fallback = await fixture();
  delete fallback.hosts[0].record.comments_doc;
  assert.equal((await audit(fallback)).state, "ready");
  const e = await fixture();
  const other = await fixture(2);
  other.hosts[0].record.documentId = e.hosts[0].record.documentId;
  other.hosts[0].record.tree = e.hosts[0].record.tree;
  e.hosts.push(other.hosts[0]);
  e.catalogs[0].entries.push(other.catalogs[0].entries[0]);
  assert.equal((await audit(e)).state, "blocked");
});

test("malformed and conflicting evidence blocks, never trusts exporter success", async (t) => {
  const changes = [
    [
      "schema",
      (e) => {
        e.schema = "future";
      },
    ],
    [
      "duplicate host",
      (e) => {
        e.hosts.push(e.hosts[0]);
      },
    ],
    [
      "duplicate account",
      (e) => {
        e.catalogs.push(e.catalogs[0]);
      },
    ],
    [
      "duplicate key",
      (e) => {
        e.hosts[0].plain.push(e.hosts[0].plain[0]);
      },
    ],
    [
      "owner",
      (e) => {
        e.hosts[0].record.owner = "wrong";
      },
    ],
    [
      "tree",
      (e) => {
        e.hosts[0].record.tree = "bad";
      },
    ],
    [
      "selector",
      (e) => {
        e.hosts[0].record.recordStorage = "future";
      },
    ],
    [
      "comments selector",
      (e) => {
        e.hosts[0].record.comments_doc = "invalid";
      },
    ],
    [
      "catalog trash",
      (e) => {
        e.catalogs[0].entries[0][0] = `trash/${id(1)}`;
      },
    ],
    [
      "catalog tombstone",
      (e) => {
        e.catalogs[0].entries.push([`host/deleted/${id(1)}`, true]);
      },
    ],
    [
      "creation conflict",
      (e) => {
        e.hosts[0].creation = { metadata: { ...e.hosts[0].record, documentId: "wrong" } };
      },
    ],
    [
      "export error",
      (e) => {
        e.hosts[0].error = "read failed";
      },
    ],
    [
      "pending missing",
      (e) => {
        delete e.hosts[0].pending_keys;
      },
    ],
    [
      "manifest version",
      (e) =>
        mutateManifest(e, (m) => {
          m.version = 3;
        }),
    ],
    [
      "manifest key version",
      (e) =>
        mutateManifest(e, (m) => {
          delete m.version;
        }),
    ],
    [
      "manifest bound",
      (e) =>
        mutateManifest(e, (m) => {
          m.seq = Number.MAX_SAFE_INTEGER;
        }),
    ],
    [
      "manifest heads",
      (e) =>
        mutateManifest(e, (m) => {
          m.heads = ["0".repeat(64)];
        }),
    ],
    [
      "part count",
      (e) =>
        mutateManifest(e, (m) => {
          m.snapshot.parts = 1e12;
        }),
    ],
    [
      "fraction seq",
      (e) =>
        mutateManifest(e, (m) => {
          m.seq = 2.5;
        }),
    ],
    [
      "known heads",
      (e) => {
        e.hosts[0].known_heads.comments = ["0".repeat(64)];
      },
    ],
    [
      "base64",
      (e) => {
        e.hosts[0].plain[0][1] = "not base64";
      },
    ],
    [
      "corrupt body",
      (e) => {
        e.hosts[0].plain.find(([k]) => k.includes("/o/"))[1] = "AAAA";
      },
    ],
  ];
  for (const [name, change] of changes)
    await t.test(name, async () => {
      const e = await fixture();
      change(e);
      const result = await audit(e);
      assert.equal(result.state, "blocked", JSON.stringify(result));
      assert.equal(result.removal_ready, false);
    });
  assert.equal((await auditInventory("{")).state, "blocked");
  assert.equal((await auditInventory(" ".repeat(LIMITS.inputBytes + 1))).state, "blocked");
  assert.equal(
    (await auditInventory(JSON.stringify([{ Key: "synthetic", VersionId: "version", Size: 12 }])))
      .state,
    "blocked",
  );
});

test("CLI reads one synthetic regular file, leaves bytes unchanged, and has no success exit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pages-inventory-test-"));
  const script = new URL("./migration-inventory.mjs", import.meta.url);
  const run = (args) =>
    spawnSync(process.execPath, [script.pathname, ...args], { encoding: "utf8", timeout: 20_000 });
  try {
    const path = join(dir, "synthetic.json");
    const input = JSON.stringify(await fixture());
    writeFileSync(path, input);
    const result = run(["--offline-evidence", path]);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(JSON.parse(result.stdout).state, "ready");
    assert.equal(readFileSync(path, "utf8"), input);
    symlinkSync(path, join(dir, "link.json"));
    for (const target of [join(dir, "link.json"), dir, join(dir, "absent")]) {
      const bad = run(["--offline-evidence", target]);
      assert.equal(bad.status, 2);
      assert.equal(JSON.parse(bad.stdout).state, "blocked");
    }
    assert.equal(run([]).status, 2);
    assert.equal(run(["https://example.invalid"]).status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
