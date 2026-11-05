import assert from "node:assert/strict";
import { test } from "node:test";
import { main, parseArgs } from "./d1.mjs";
import { EXIT_CELL_MISSING } from "./quota-rules.mjs";

function capture() {
  const out = [];
  const err = [];
  return { out, err, io: { out: (line) => out.push(line), err: (line) => err.push(line) } };
}

test("a command without a target or SQL sends nothing", async () => {
  for (const argv of [["SELECT 1"], ["--target", "pages"], ["--target", "pages", "a", "b"]]) {
    const { io } = capture();
    let sent = false;
    const code = await main(argv, { ...io, transport: async () => (sent = true) });
    assert.equal(code, 2, argv.join(" "));
    assert.equal(sent, false);
  }
  assert.throws(
    () => parseArgs(["--target", "pages", "--file", "q.sql", "SELECT 1"]),
    /as an argument/,
  );
});

test("a target without a D1 database is refused before sending", async () => {
  const { io, err } = capture();
  const code = await main(["--target", "page3", "SELECT 1"], { ...io, transport: async () => {} });
  assert.equal(code, 2);
  assert.match(err.join("\n"), /no quota database|page3/);
});

test("rows print one JSON object per line and the receipt names the target", async () => {
  const { io, out, err } = capture();
  let received;
  const code = await main(["--target", "pages", "SELECT name FROM sqlite_master"], {
    ...io,
    transport: async (sql) => {
      received = sql;
      return { code: 0, stdout: '{"name":"a"}\n{"name":"b"}\n', stderr: "" };
    },
  });
  assert.equal(code, 0);
  assert.equal(received, "SELECT name FROM sqlite_master");
  assert.deepEqual(out, ['{"name":"a"}', '{"name":"b"}']);
  assert.match(
    err.at(-1),
    /pages-next-auth on pages \(s3:\/\/[^)]*standalone\/pages-live\): 2 rows/,
  );
});

test("stdin SQL is read when the argument is -", async () => {
  const { io } = capture();
  let received;
  await main(["--target", "page10", "-"], {
    ...io,
    stdin: () => "SELECT 2",
    transport: async (sql) => {
      received = sql;
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  assert.equal(received, "SELECT 2");
});

test("a missing database cell reports that nothing ran", async () => {
  const { io, err } = capture();
  const code = await main(["--target", "pages", "SELECT 1"], {
    ...io,
    transport: async () => ({ code: EXIT_CELL_MISSING, stdout: "", stderr: "" }),
  });
  assert.equal(code, 1);
  assert.match(err.join("\n"), /Nothing ran/);
});

test("a failed statement warns that a write may have committed", async () => {
  const { io, err } = capture();
  const code = await main(["--target", "pages", "UPDATE t SET x = 1"], {
    ...io,
    transport: async () => ({ code: 1, stdout: "", stderr: "Error: no such table: t\n" }),
  });
  assert.equal(code, 1);
  assert.match(err.join("\n"), /no such table: t/);
  assert.match(err.join("\n"), /may still have committed/);
});
