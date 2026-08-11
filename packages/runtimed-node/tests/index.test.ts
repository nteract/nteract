import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vite-plus/test";

const require = createRequire(import.meta.url);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("@runtimed/node root wrapper", () => {
  it("wraps path-opened native sessions in the high-level Session API", async () => {
    const fixture = fs.mkdtempSync(path.join(packageRoot, ".index-test-"));
    temporaryDirectories.push(fixture);
    for (const file of ["index.cjs", "session.cjs", "napi-observables.cjs"]) {
      fs.copyFileSync(path.join(packageRoot, "src", file), path.join(fixture, file));
    }
    fs.writeFileSync(
      path.join(fixture, "binding.cjs"),
      `
const calls = [];
class NativeSession {}
module.exports = {
  calls,
  Session: NativeSession,
  openNotebookPath: async (notebookPath, options) => {
    calls.push({ notebookPath, options });
    return { notebookId: "notebook-from-path" };
  },
};
`,
    );

    const api = require(path.join(fixture, "index.cjs")) as {
      calls: Array<{ notebookPath: string; options: unknown }>;
      NativeSession: new () => unknown;
      Session: new (native: unknown) => { notebookId: string };
      openNotebookPath(
        notebookPath: string,
        options?: { socketPath?: string; peerLabel?: string },
      ): Promise<{ notebookId: string }>;
    };
    const options = { socketPath: "/tmp/runtimed.sock", peerLabel: "host" };
    const session = await api.openNotebookPath("/tmp/analysis.ipynb", options);

    expect(session).toBeInstanceOf(api.Session);
    expect(session).not.toBeInstanceOf(api.NativeSession);
    expect(session.notebookId).toBe("notebook-from-path");
    expect(api.calls).toEqual([{ notebookPath: "/tmp/analysis.ipynb", options }]);
  });
});
