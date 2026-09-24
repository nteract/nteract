import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPyodide } from "pyodide";
import {
  PackageResolver,
  PackageAcquisition,
  validateRequirements,
  validateLockedWheel,
} from "../../../apps/preview-python/src/package-resolver.js";

const root = new URL("../", import.meta.url);
async function pythonPackages() {
  const python = await loadPyodide({
    indexURL: dirname(fileURLToPath(import.meta.resolve("pyodide"))) + "/",
    stdout() {},
    stderr() {},
  });
  const packages = JSON.parse(await readFile(new URL("dist/packages.json", root), "utf8"));
  for (const { filename } of packages)
    python.unpackArchive(
      new Uint8Array(await readFile(new URL(`.scratch/packages/${filename}`, root))),
      "zip",
      { extractDir: "/packages/site-packages" },
    );
  python.runPython("import sys; sys.path.insert(0, '/packages/site-packages')");
  python.runPython(await readFile(new URL("runtime/packages.py", root), "utf8"));
  return python;
}

test("structured version ranges remain intact; unsupported sources are rejected", () => {
  assert.deepEqual(validateRequirements(["numpy>=1.24,<2", "snowballstemmer[extra]>=2"]), [
    "numpy>=1.24,<2",
    "snowballstemmer[extra]>=2",
  ]);
  for (const value of [
    ["six @ https://example.com/six.whl"],
    ["../six.whl"],
    ["https://example.com"],
    ["six\nrequests"],
    Array(65).fill("six"),
  ])
    assert.throws(() => validateRequirements(value));
});

test("pinned micropip resolves a dependency cycle without leaving asynchronous work", async () => {
  const python = await pythonPackages();
  const artifacts = JSON.parse(
    python.runPython(`
def cycle_artifacts():
    resources = {}
    for name, other in [("cycle-a", "cycle-b"), ("cycle-b", "cycle-a")]:
        stem = name.replace("-", "_") + "-1.0"
        filename = stem + "-py3-none-any.whl"
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            archive.writestr(stem + ".dist-info/METADATA", f"Metadata-Version: 2.1\\nName: {name}\\nVersion: 1.0\\nRequires-Dist: {other}>=1\\n")
            archive.writestr(stem + ".dist-info/WHEEL", "Wheel-Version: 1.0\\nTag: py3-none-any\\n")
        data = buffer.getvalue()
        url = "https://files.pythonhosted.org/packages/aa/bb/cccc/" + filename
        resources[url] = {"body": base64.b64encode(data).decode()}
        resources["https://pypi.org/pypi/" + name + "/json"] = {"json": {"releases": {"1.0": [{"filename": filename, "url": url, "size": len(data), "digests": {"sha256": hashlib.sha256(data).hexdigest()}}]}}}
    return json.dumps(resources)
cycle_artifacts()
`),
  );
  const plan = python.globals.get("plan_packages");
  let rounds = 0;
  const resolver = new PackageResolver({
    create: async () => ({
      plan: async (value) => {
        const pending = plan(JSON.stringify(value));
        try {
          const result = JSON.parse(await pending);
          assert.equal(
            await python.runPythonAsync(
              "import asyncio\nlen([task for task in asyncio.all_tasks() if task is not asyncio.current_task()])",
            ),
            0,
          );
          rounds++;
          return result;
        } finally {
          pending.destroy();
        }
      },
      dispose: async () => {},
    }),
    fetchImpl: async (url) => {
      assert.ok(artifacts[url], "only fixture metadata and wheels may be requested");
      return artifacts[url].json
        ? Response.json(artifacts[url].json)
        : new Response(Buffer.from(artifacts[url].body, "base64"));
    },
  });
  try {
    const result = await resolver.resolve(["cycle-a"]);
    assert.deepEqual(result.wheels.map((wheel) => wheel.name).sort(), ["cycle-a", "cycle-b"]);
    assert.ok(rounds < 10);
    assert.deepEqual(result.wheels.find((wheel) => wheel.name === "cycle-a").dependencies, [
      "cycle-b",
    ]);
  } finally {
    plan.destroy();
  }
});

test("lock restore rejects credentials, redirects, foreign origins, native wheels and bad hashes", async () => {
  const url = "https://files.pythonhosted.org/packages/aa/bb/cccc/six-1.0-py3-none-any.whl";
  const wheel = {
    name: "six",
    version: "1.0",
    filename: "six-1.0-py3-none-any.whl",
    url,
    sha256: "0".repeat(64),
    size: 4,
  };
  assert.deepEqual(validateLockedWheel(wheel), { ...wheel, dependencies: [] });
  for (const changed of [
    { url: url.replace("https://", "https://secret@") },
    { url: url + "?token=x" },
    { url: url.replace("files.pythonhosted.org", "127.0.0.1") },
    { filename: "six-1.0-cp313-linux_x86_64.whl" },
    { sha256: "bad" },
    { size: 100_000_000 },
  ])
    assert.throws(() => validateLockedWheel({ ...wheel, ...changed }));
  let options;
  const acquisition = new PackageAcquisition({
    fetchImpl: async (_url, opts) => {
      options = opts;
      return new Response("test");
    },
  });
  await assert.rejects(acquisition.download(wheel), /integrity/);
  assert.equal(options.redirect, "error");
  assert.equal(options.credentials, "omit");
  await assert.rejects(
    acquisition.acquire("https://files.pythonhosted.org/unknown.whl"),
    /unapproved/,
  );
});

test(
  "real pinned micropip resolves and installs a pure PyPI package offline",
  { skip: process.env.NTERACT_PACKAGE_NETWORK_TEST !== "1", timeout: 120_000 },
  async () => {
    const python = await pythonPackages();
    const plan = python.globals.get("plan_packages");
    const tenant = await pythonPackages();
    const install = tenant.globals.get("install_packages");
    const invoke = async (fn, value) => {
      const pending = fn(JSON.stringify(value));
      try {
        return JSON.parse(await pending);
      } finally {
        pending.destroy();
      }
    };
    let disposed = 0;
    const resolver = new PackageResolver({
      create: async () => ({
        plan: (value) => invoke(plan, value),
        dispose: async () => {
          disposed++;
        },
      }),
    });
    try {
      const resolved = await resolver.resolve(["snowballstemmer>=2,<4"]);
      assert.equal(disposed, 1);
      assert.ok(resolved.wheels.some((wheel) => wheel.name === "snowballstemmer"));
      assert.equal(
        python.runPython(
          "import importlib.util; importlib.util.find_spec('snowballstemmer') is None",
        ),
        true,
      );
      const result = await invoke(install, resolved);
      assert.equal(result.status, "ready");
      assert.ok(result.installed.some((spec) => spec.startsWith("snowballstemmer==")));
      assert.equal(
        tenant.runPython(
          "import snowballstemmer; snowballstemmer.stemmer('english').stemWord('running')",
        ),
        "run",
      );
      const transitive = await resolver.resolve(["requests[socks]>=2.32,<3"]);
      assert.ok(transitive.wheels.some((wheel) => wheel.name === "pysocks"));
      assert.ok(transitive.wheels.some((wheel) => wheel.name === "urllib3"));
      assert.equal((await invoke(install, transitive)).status, "ready");
      const incomplete = await invoke(install, {
        requirements: ["not-a-real-installed-package==1"],
        wheels: [],
      });
      assert.equal(incomplete.status, "error");
      const unsatisfied = await invoke(install, { requirements: ["requests<1"], wheels: [] });
      assert.equal(unsatisfied.status, "error");
      await assert.rejects(resolver.resolve(["requests>=2", "requests<1"]), /compatible|conflicts/);
      assert.equal(
        await python.runPythonAsync(
          "import asyncio\nlen([task for task in asyncio.all_tasks() if task is not asyncio.current_task()])",
        ),
        0,
      );
      await assert.rejects(resolver.resolve(["tensorflow"]), /compatible/);
      assert.equal(disposed, 4);
    } finally {
      plan.destroy();
      install.destroy();
    }
  },
);
