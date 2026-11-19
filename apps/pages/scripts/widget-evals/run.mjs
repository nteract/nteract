import path from "node:path";
import { tmpdir } from "node:os";
import { mkdir, writeFile, readFile, mkdtemp, access, unlink } from "node:fs/promises";
import { randomInt, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dir, outputDir, session, origin } from "./shared.mjs";
import { grade } from "./grade.mjs";
const exec = promisify(execFile);
const here = dir;
const cohort = process.argv[2] ?? new Date().toISOString().replaceAll(":", "-");
if (cohort === "." || cohort === ".." || !/^[\w.-]+$/.test(cohort))
  throw Error("Supply a cohort name");
const root = path.join(outputDir, "runs", cohort);
await mkdir(root, { recursive: true });
const lock = path.join(root, "running");
await writeFile(lock, String(process.pid), { flag: "wx" });
try {
  const file = path.join(root, "order.json");
  let order;
  try {
    order = JSON.parse(await readFile(file, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    order = [];
    const repetitions = Number(process.env.EVAL_REPETITIONS ?? 5);
    if (!Number.isInteger(repetitions) || repetitions < 1)
      throw Error("EVAL_REPETITIONS must be a positive integer");
    const models = process.env.EVAL_MODELS?.split(",") ?? [
      "thinkingmachines/inkling-2-small",
      "anthropic/claude-haiku-4.5",
    ];
    if (models.some((m) => !/^[-\w.]+\/[-\w.]+$/.test(m)) || new Set(models).size !== models.length)
      throw Error("Use distinct provider/model names for EVAL_MODELS");
    for (let round = 1; round <= repetitions; round++) {
      const block = models.flatMap((model) =>
        ["old", "new"].map((arm) => ({ round, model: "kilo/" + model, arm })),
      );
      for (let i = block.length - 1; i > 0; i--) {
        const j = randomInt(i + 1);
        [block[i], block[j]] = [block[j], block[i]];
      }
      order.push(...block);
    }
    await writeFile(file, JSON.stringify(order, null, 2));
  }
  const prompt =
    "Build a vertical bar chart with Observable Plot on the assigned Page. Daily counts are Mon 4, Tue 7, Wed 2. Start with all three days. Give each bar a hover title like 'Mon: 4'. Add buttons named 'Last 2 days' and 'All days' so a reader can filter and restore the chart. The chart should work using only assets on this deployment. Try the controls as a reader and tell me what you saw.";
  async function trial({ round, model, arm }) {
    const name = [round, model.slice(5).replace("/", "--"), arm].join("_");
    const record = path.join(root, name);
    try {
      await access(path.join(record, "result.json"));
      return;
    } catch {}
    await mkdir(record, { recursive: true });
    const project = await mkdtemp(path.join(tmpdir(), "fresh-page-"));
    const { browser, page, client, tool } = await session();
    try {
      const { page_id } = await tool("create_page", {
        title: "Daily counts",
        markdown: "Daily counts for the sample week.",
        nonce: crypto.randomUUID(),
      });
      const initial = await tool("read_page", { page_id, views: true });
      if (initial.widget_imports.catalog !== null || initial.views.length)
        throw Error("Invalid starting state");
      const config = {
        agent: {
          candidate: {
            mode: "primary",
            model,
            description: "Pages author",
            prompt: "Use the available Pages and browser tools to fulfill the user's request.",
            permission: {
              "*": "deny",
              pages_read_page: "allow",
              pages_edit_page: "allow",
              pages_read_guide: "allow",
              pages_upload_text_asset: "allow",
              pages_inspect_widget: "allow",
            },
          },
        },
        mcp: {
          pages: {
            type: "local",
            command: [process.execPath, path.join(here, "bridge.mjs"), page_id, arm],
            enabled: true,
          },
        },
      };
      await writeFile(path.join(project, "kilo.json"), JSON.stringify(config));
      const question = prompt + " Assigned Page ID: " + page_id;
      await writeFile(
        path.join(record, "input.json"),
        JSON.stringify(
          {
            model,
            arm,
            round,
            page_id,
            question,
            guideSHA256: createHash("sha256")
              .update(await readFile(path.join(outputDir, "guides", arm, "anywidget.txt")))
              .digest("hex"),
          },
          null,
          2,
        ),
      );
      const start = Date.now();
      let stdout = "",
        stderr = "",
        exit = "completed";
      try {
        ({ stdout, stderr } = await exec(
          process.env.KILO_BIN ?? "kilo",
          [
            "run",
            "--pure",
            "--dir",
            project,
            "--agent",
            "candidate",
            "--model",
            model,
            "--format",
            "json",
            question,
          ],
          {
            cwd: project,
            env: { ...process.env, PWD: project, KILO_DISABLE_EXTERNAL_SKILLS: "true" },
            timeout: 240000,
            maxBuffer: 24e6,
          },
        ));
      } catch (e) {
        stdout = e.stdout ?? "";
        stderr = e.stderr ?? "";
        exit = e.killed ? "timeout" : "runner-error";
      }
      const seconds = +((Date.now() - start) / 1000).toFixed(1);
      await writeFile(path.join(record, "events.jsonl"), stdout, { mode: 0o600 });
      await writeFile(path.join(record, "stderr.log"), stderr, { mode: 0o600 });
      const events = stdout.split("\n").flatMap((l) => {
        try {
          return [JSON.parse(l)];
        } catch {
          return [];
        }
      });
      const calls = events.filter((e) => e.type === "tool_use").map((e) => e.part);
      const final = (await tool("read_page", { page_id, views: true })).widget_imports;
      const rendered = await grade(page, origin + "/p/" + page_id);
      const pinAt = calls.findIndex(
        (c) =>
          c.tool === "pages_edit_page" &&
          c.state.input?.operations?.some((o) => o.op === "set_widget_imports") &&
          c.state.status === "completed" &&
          !c.state.output?.includes('"isError":true'),
      );
      const placeAt = calls.findIndex(
        (c) =>
          c.state.status === "completed" &&
          c.tool === "pages_edit_page" &&
          c.state.input?.operations?.some((o) => o.op === "insert_node" && o.node?.type === "view"),
      );
      const result = {
        origin,
        model,
        round,
        arm,
        page_id,
        seconds,
        exit,
        tools: calls.length,
        guides: calls.filter((c) => c.tool === "pages_read_guide").map((c) => c.state.input.path),
        buttons: calls
          .filter((c) => c.tool === "pages_inspect_widget")
          .map((c) => c.state.input.button ?? null),
        catalog: final.catalog,
        pinAt,
        placeAt,
        rendered,
        claim: events.filter((e) => e.type === "text").at(-1)?.part.text,
        providerError: events.find((e) => e.type === "error")?.error?.data?.message?.slice(0, 300),
      };
      await writeFile(path.join(record, "result.json"), JSON.stringify(result, null, 2));
      console.log(
        name,
        exit,
        seconds,
        JSON.stringify([rendered.initial, rendered.filtered, rendered.restored]),
      );
    } finally {
      await client.close();
      await browser.close();
    }
  }
  let index = 0;
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (index < order.length) {
        const job = order[index++];
        try {
          await trial(job);
        } catch (e) {
          process.exitCode = 1;
          console.error(JSON.stringify(job), e.message);
        }
      }
    }),
  );
} finally {
  await unlink(lock);
}
