import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import {
  checkAccountCommand,
  codexHeaderHelper,
  kiloConfig,
  kiloApiKeyConfig,
  saveKeyCommand,
  setupPrompt,
} from "../agent-client-setup.mjs";
import { connectAgentResponse } from "../connect-agent.mjs";
import { FAVICON_LINK } from "../shared/favicon.mjs";

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
    path.unlink()
    for invalid in ["", "bad key"]:
        getpass.getpass = lambda _: invalid
        try:
            exec(${JSON.stringify(code)}, {})
            raise AssertionError("invalid input accepted")
        except SystemExit:
            pass
        assert not path.exists()
    path.write_text("synthetic-test-key")
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

test("save command refuses existing keys and symlinks, including a file created during the prompt", () => {
  const code = saveKeyCommand.slice("python3 -c '\n".length, -2);
  const result = spawnSync(
    "python3",
    [
      "-c",
      `
import getpass, pathlib, sys, tempfile
with tempfile.TemporaryDirectory() as directory:
    pathlib.Path.home = lambda: pathlib.Path(directory)
    sys.stdin = type("Terminal", (), {"isatty": lambda self: True})()
    path = pathlib.Path(directory) / ".config/pages/anaconda-api-key"
    path.parent.mkdir(parents=True)
    target = path.parent / "anaconda-api-key-rgbkrk"
    target.write_text("existing-account-key")
    def unexpected_prompt(_):
        raise AssertionError("must refuse existing files before asking for a key")
    for kind in ["file", "symlink", "dangling", "race"]:
        getpass.getpass = unexpected_prompt
        if kind == "file":
            path.write_text("original-key")
        elif kind in ["symlink", "dangling"]:
            path.symlink_to(target if kind == "symlink" else path.parent / "missing")
        else:
            def race(_):
                path.write_text("original-key")
                return "replacement-key"
            getpass.getpass = race
        try:
            exec(${JSON.stringify(code)}, {})
            raise AssertionError("existing key overwritten")
        except SystemExit as error:
            assert "file already exists" in str(error)
        assert target.read_text() == "existing-account-key"
        if kind in ["file", "race"]:
            assert path.read_text() == "original-key"
        else:
            assert path.is_symlink()
            assert not (path.parent / "missing").exists()
        path.unlink()
`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
});

test("setup prompt requires account-safe selection and session verification", () => {
  const prompt = setupPrompt("https://pages.example");
  for (const fact of [
    "Inspect filenames, not secrets",
    "ask me before reusing or replacing an existing key",
    "~/.config/pages/anaconda-api-key-rgbkrk",
    "~/.config/pages/anaconda-api-key remains the default",
    "Reload MCP or start a new session, then call list_pages from that session",
    "Configuration alone is not verification",
  ])
    assert.ok(prompt.includes(fact), fact);
});

test("HTTP account recipe keeps keys private, refuses redirects, and sanitizes failures", () => {
  const command = checkAccountCommand("http://127.0.0.1:12345");
  const code = command.slice("python3 - <<'PY'\n".length, -3);
  const result = spawnSync(
    "python3",
    [
      "-c",
      `
import contextlib, http.server, io, json, pathlib, sys, tempfile, threading
key = 'synthetic-private-key"'
calls = []
class Handler(http.server.BaseHTTPRequestHandler):
    mode = "success"
    def log_message(self, *args):
        pass
    def do_GET(self):
        calls.append(self.path)
        assert self.headers["Authorization"] == "Bearer " + key
        if self.mode == "bad-status":
            self.wfile.write((key + "\\r\\n\\r\\n").encode())
            return
        if self.mode == "incomplete":
            self.wfile.write(b"HTTP/1.0 200 OK\\r\\nContent-Length: 1000\\r\\n\\r\\n" + key.encode())
            return
        status = {"redirect": 302, "unauthorized": 401, "outage": 503}.get(self.mode, 200)
        self.send_response(status)
        if self.mode == "redirect":
            self.send_header("Location", "/leaked?key=" + key)
        self.end_headers()
        if self.mode == "success":
            body = json.dumps({"account": {"principal": "account-1", "display_name": "Test", "email": "test@example.invalid"}, "credential": {"kind": "api-key", "can_write": True}, "ignored": key})
        elif self.mode == "echo":
            body = json.dumps({"account": {"principal": key}, "credential": {"kind": "api-key", "can_write": False}})
        else:
            body = key
        self.wfile.write(body.encode())
server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
try:
    with tempfile.TemporaryDirectory() as directory:
        pathlib.Path.home = lambda: pathlib.Path(directory)
        path = pathlib.Path(directory) / ".config/pages/anaconda-api-key"
        path.parent.mkdir(parents=True)
        path.write_text(key)
        code = ${JSON.stringify(code)}.replace("http://127.0.0.1:12345", "http://127.0.0.1:%d" % server.server_port)
        for mode in ["success", "echo", "redirect", "unauthorized", "outage", "malformed", "bad-status", "incomplete", "missing", "empty"]:
            Handler.mode = mode
            output = io.StringIO()
            before = len(calls)
            if mode == "missing":
                path.unlink()
            elif mode == "empty":
                path.write_text("")
            with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
                try:
                    exec(code, {})
                    assert mode in ["success", "echo"]
                except SystemExit as error:
                    assert mode not in ["success", "echo"]
                    print(str(error))
            text = output.getvalue()
            assert key not in text, text
            assert "synthetic-private-key" not in text, text
            if mode == "success":
                assert json.loads(text)["account"]["principal"] == "account-1"
                assert "ignored" not in text
            elif mode == "redirect":
                assert "Redirect refused" in text
                assert len(calls) == before + 1
            elif mode in ["unauthorized", "outage"]:
                assert "HTTP " in text
            elif mode in ["bad-status", "incomplete"]:
                assert text.strip() == "Pages account check failed. Check connectivity and the configured Pages origin."
            elif mode in ["missing", "empty"]:
                assert len(calls) == before
        assert all(path == "/whoami" for path in calls)
finally:
    server.shutdown()
    server.server_close()
    thread.join()
`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
});

test("Kilo OAuth recipe binds the supported public client without a static credential", () => {
  const { pages } = JSON.parse(kiloConfig("https://page7.runtimed.run")).mcp;
  assert.equal(pages.url, "https://page7.runtimed.run/mcp");
  assert.deepEqual(pages.oauth, {
    clientId: "pages-kilo",
    scope: "pages:read pages:write offline_access",
  });
  assert.deepEqual(pages.headers, { "X-Pages-Driver": "Kilo" });
});

test("Kilo API-key recipe uses static bearer auth and a file reference rather than an empty credential", () => {
  const { pages } = JSON.parse(kiloApiKeyConfig("https://page7.runtimed.run")).mcp;
  assert.equal(pages.oauth, false);
  assert.deepEqual(pages.headers, {
    Authorization: "Bearer {file:~/.config/pages/anaconda-api-key}",
    "X-Pages-Driver": "Kilo",
    // One shared entry; each worktree names its session through PAGES_AGENT.
    "X-Pages-Agent": "{env:PAGES_AGENT}",
  });
});

test("copy actions copy only public recipes and report the matching next step", async () => {
  const response = connectAgentResponse(new Request("https://pages.example/connect"), {
    NOTEBOOK_CLOUD_PUBLIC_ORIGIN: "https://pages.example",
  });
  const page = await response.text();
  assert.ok(page.includes(FAVICON_LINK), "the setup page carries the inlined tab icon");
  const dom = new JSDOM(page, { runScripts: "outside-only" });
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
