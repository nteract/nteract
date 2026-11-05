// ONE-SHOT MIGRATION tests: delete with content-migration-operator.mjs.
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  callScript,
  cellsScript,
  operatorConfig,
  operatorRun,
  parseArgs,
} from "./content-migration-operator.mjs";

test("arguments and the target's profile", () => {
  const args = parseArgs(["--target", "pages", "--mode", "apply", "--include-connected"]);
  assert.equal(args.includeConnected, true);
  assert.match(args.log, /^content-migration-operator-pages-apply-.*\.jsonl$/);
  assert.throws(() => parseArgs(["--target", "pages", "--mode", "go"]));
  assert.deepEqual(operatorConfig("pages"), {
    target: "pages",
    host: "lab1",
    service: "nteract-pages-live",
    listen: "127.0.0.1:9481",
    runtime: "/opt/nteract-pages-live/celld",
    bucket: "s3://nteract-celld-lab-621741996708/standalone/pages-live",
    region: "us-east-1",
  });
  assert.equal(operatorConfig("page10").listen, "127.0.0.1:9480");
  assert.match(
    cellsScript(operatorConfig("pages")),
    /cell list Page --bucket s3:\/\/.* --all --json$/m,
  );
});

/** Run callScript locally with stub sudo and curl: sudo runs its command,
 * `cat` of the secret answers SECRET, and curl prints the config it read. */
function runCallScript(body) {
  const dir = mkdtempSync(path.join(tmpdir(), "operator-call-"));
  try {
    writeFileSync(
      path.join(dir, "sudo"),
      [
        "#!/bin/bash",
        'while [ "$1" = "-n" ] || [ "$1" = "-u" ]; do [ "$1" = "-u" ] && shift; shift; done',
        'if [ "$1" = "cat" ]; then echo "SECRET-0123456789"; exit 0; fi',
        'exec "$@"',
      ].join("\n"),
    );
    writeFileSync(path.join(dir, "curl"), "#!/bin/bash\ncat\n");
    chmodSync(path.join(dir, "sudo"), 0o755);
    chmodSync(path.join(dir, "curl"), 0o755);
    return execFileSync("bash", ["-c", callScript(operatorConfig("pages"))], {
      input: JSON.stringify(body),
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
      encoding: "utf8",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** curl's config-file string unescaping, for the fields callScript writes. */
const configValue = (config, name) => {
  const line = config.split("\n").find((entry) => entry.startsWith(`${name} = `));
  return JSON.parse(line.slice(name.length + 3));
};

test("the remote call script sends the body and secret through curl's config, not argv", () => {
  const body = { action: "run", principal: 'user:a"b\\c', mode: "dry_run", page_ids: [] };
  const config = runCallScript(body);
  assert.deepEqual(JSON.parse(configValue(config, "data-raw")), body);
  assert.equal(configValue(config, "url"), "http://127.0.0.1:9481/api/operator/content-migration");
  assert.ok(config.includes('header = "x-pages-operator-secret: SECRET-0123456789"'));
});

function fakeTransport({ fail } = {}) {
  const calls = [];
  const pages = {
    "user:a": [{ page_id: "p1", cell_id: "c1", status: "unchanged" }],
    "user:b": [{ page_id: "p2", cell_id: "c2", status: "would_normalize" }],
  };
  return {
    calls,
    async call(body) {
      calls.push(body);
      if (fail && calls.length === fail) return { status: 502, text: '{"error":"Bad gateway"}' };
      if (body.action === "accounts")
        return {
          status: 200,
          text: JSON.stringify({ principals: ["user:a", "user:b"], source: "d1_projection" }),
        };
      if (body.action === "run") {
        const list = pages[body.principal];
        return {
          status: 200,
          text: JSON.stringify({
            pages: list,
            visited: list.map((page) => page.page_id),
            next: null,
            totals: { pages: 1 },
            targets: { total: 1 },
            tombstones: [],
            progress: { phase: body.mode === "apply" ? "done" : "none" },
          }),
        };
      }
      if (body.action === "probe")
        return {
          status: 200,
          text: JSON.stringify({
            cells: body.cell_ids.map((cell_id) => ({
              cell_id,
              page_id: null,
              owner: null,
              state: "missing",
            })),
          }),
        };
      throw Error("unexpected");
    },
    async cells() {
      return ["c1", "c2", "c3"];
    },
  };
}

test("the operator run covers every account and probes the cells no run reached", async () => {
  const transport = fakeTransport();
  const logged = [];
  const report = await operatorRun({
    mode: "apply",
    includeConnected: true,
    transport,
    log: (record) => logged.push(record),
  });
  assert.deepEqual(
    report.accounts.map((account) => [account.principal, account.visited, account.progress.phase]),
    [
      ["user:a", 1, "done"],
      ["user:b", 1, "done"],
    ],
  );
  assert.ok(transport.calls.filter((c) => c.action === "run").every((c) => c.include_connected));
  assert.equal(report.reached, 2);
  assert.equal(report.page_cells, 3);
  assert.deepEqual(report.unreached, [
    { cell_id: "c3", page_id: null, owner: null, state: "missing" },
  ]);
  assert.deepEqual(
    logged.map((record) => [record.request, record.principal]),
    [
      ["accounts", undefined],
      ["run", "user:a"],
      ["run", "user:b"],
      ["probe", undefined],
    ],
  );
});

test("a failed call keeps the report so far and logs the refusal", async () => {
  const logged = [];
  const error = await operatorRun({
    mode: "dry_run",
    transport: fakeTransport({ fail: 3 }),
    log: (record) => logged.push(record),
  }).catch((reason) => reason);
  assert.match(error.message, /502/);
  assert.equal(error.report.accounts[0].visited, 1);
  assert.equal(error.report.accounts[1].error, error.message);
  assert.equal(logged.at(-1).status, 502);
});
