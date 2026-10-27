import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { codexHeaderHelper, kiloConfig, saveKeyCommand } from "../agent-client-setup.mjs";
import { connectAgentResponse } from "../connect-agent.mjs";

test("private key recipe keeps secrets out of output and rejects empty input without overwriting", () => {
  const code = saveKeyCommand.slice("python3 -c '\n".length, -2);
  const result = spawnSync(
    "python3",
    [
      "-c",
      `
import contextlib, getpass, io, pathlib, stat, sys, tempfile
with tempfile.TemporaryDirectory() as directory:
    pathlib.Path.home = lambda: pathlib.Path(directory)
    sys.stdin = type("Terminal", (), {"isatty": lambda self: True})()
    getpass.getpass = lambda _: "synthetic-test-key"
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        exec(${JSON.stringify(code)}, {})
    path = pathlib.Path(directory) / ".config/pages/anaconda-api-key"
    assert path.read_text() == "synthetic-test-key"
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert "synthetic-test-key" not in output.getvalue()
    for invalid in ["", "bad key"]:
        getpass.getpass = lambda _: invalid
        try:
            exec(${JSON.stringify(code)}, {})
            raise AssertionError("invalid input accepted")
        except SystemExit:
            pass
        assert path.read_text() == "synthetic-test-key"
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        exec(${JSON.stringify(codexHeaderHelper)}, {})
    import json
    assert json.loads(output.getvalue()) == {"Authorization": "Bearer synthetic-test-key"}
    path.write_text("")
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        try:
            exec(${JSON.stringify(codexHeaderHelper)}, {})
            raise AssertionError("empty key accepted")
        except SystemExit:
            pass
    assert output.getvalue() == ""
    path.unlink()
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        try:
            exec(${JSON.stringify(codexHeaderHelper)}, {})
            raise AssertionError("missing key accepted")
        except SystemExit as error:
            assert "Complete /connect" in str(error)
    assert output.getvalue() == ""
`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
});

test("Kilo recipe uses static bearer auth and a file reference rather than an empty credential", () => {
  const { pages } = JSON.parse(kiloConfig("https://page7.runtimed.run")).mcp;
  assert.equal(pages.oauth, false);
  assert.equal(pages.headers.Authorization, "Bearer {file:~/.config/pages/anaconda-api-key}");
});

test("copy actions copy only public recipes and report the matching next step", async () => {
  const response = connectAgentResponse(new Request("https://pages.example/connect"), {
    NOTEBOOK_CLOUD_PUBLIC_ORIGIN: "https://pages.example",
  });
  const dom = new JSDOM(await response.text(), { runScripts: "outside-only" });
  const copied = [];
  Object.defineProperty(dom.window.navigator, "clipboard", {
    value: { writeText: async (text) => copied.push(text) },
  });
  dom.window.eval(await readFile(new URL("../viewer/connect-agent.js", import.meta.url), "utf8"));
  for (const button of dom.window.document.querySelectorAll("[data-copy]")) {
    assert.equal(button.hidden, false);
    button.click();
    await new Promise(setImmediate);
    assert.equal(
      copied.at(-1),
      dom.window.document.getElementById(button.dataset.copy).textContent,
    );
    assert.equal(button.disabled, false);
    assert.ok(dom.window.document.querySelector("[role=status]").textContent.includes("copied"));
  }
  dom.window.navigator.clipboard.writeText = async () => {
    throw Error("denied");
  };
  dom.window.document.querySelector("[data-copy]").click();
  await new Promise(setImmediate);
  assert.match(dom.window.document.querySelector("[role=status]").textContent, /Couldn't copy/);
  dom.window.close();
});
