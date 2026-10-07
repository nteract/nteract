import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPyodide } from "pyodide";
import { includedPackageInventory } from "../runtime/package-inventory.js";
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
  const lockUrl = new URL("pyodide-lock.json", new URL(import.meta.resolve("pyodide")));
  python.globals.set("pyodide_lock_json", await readFile(lockUrl, "utf8"));
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

test("shipped package versions match the initial interpreter inventory before notebook additions", async () => {
  const python = await pythonPackages();
  const wheels = JSON.parse(await readFile(new URL("dist/packages.json", root), "utf8"));
  const installed = JSON.parse(python.runPython("json.dumps(inventory())"));
  const included = includedPackageInventory(wheels, installed);
  assert.ok(included.includes("pandas==2.3.1"));
  assert.ok(!included.some((name) => name.startsWith("pyarrow==")));
  assert.ok(included.includes("numpy==2.2.5"));
  assert.ok(included.includes("matplotlib==3.8.4"));
  assert.ok(wheels.length > 10);
  assert.ok(included.length >= wheels.length);
  assert.throws(
    () => includedPackageInventory([{ ...wheels[0], version: "wrong" }], installed),
    /mismatch/,
  );
  const locked = JSON.parse(
    await readFile(new URL("pyodide-lock.json", new URL(import.meta.resolve("pyodide"))), "utf8"),
  );
  assert.ok(
    wheels.length < Object.keys(locked.packages).length,
    "the full Pyodide catalog is not preinstalled",
  );
  assert.equal(
    locked.packages.tensorflow,
    undefined,
    "tensorflow is absent from the pinned catalog",
  );
  installed.push("notebook-addition==1.0");
  assert.ok(
    !included.includes("notebook-addition==1.0"),
    "initial defaults do not change with session additions",
  );
});

test("all bundled dependency closures validate against the pinned Pyodide lock", async () => {
  const python = await pythonPackages();
  const install = python.globals.get("install_packages");
  try {
    const installed = JSON.parse(python.runPython("json.dumps(inventory())"));
    python.globals.set("bundled_specs_json", JSON.stringify(installed));
    python.runPython(`
for requirement in json.loads(bundled_specs_json):
    _validate_installed([requirement])
`);
    const pending = install(JSON.stringify({ requirements: ["ipython==9.0.2"], wheels: [] }));
    try {
      const result = JSON.parse(await pending);
      assert.equal(result.status, "ready", "bundled IPython lock restores without PyPI wheels");
      assert.ok(result.installed.includes("ipython==9.0.2"));
    } finally {
      pending.destroy();
    }
  } finally {
    python.globals.delete("bundled_specs_json");
    install.destroy();
  }
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
    const result = await resolver.resolve("test-session", ["cycle-a"]);
    assert.deepEqual(result.wheels.map((wheel) => wheel.name).sort(), ["cycle-a", "cycle-b"]);
    assert.ok(rounds < 10);
    assert.deepEqual(result.wheels.find((wheel) => wheel.name === "cycle-a").dependencies, [
      "cycle-b",
    ]);
  } finally {
    plan.destroy();
  }
});

test("planner reset clears prior request artifacts between resolutions", async () => {
  const python = await pythonPackages();
  const plan = python.globals.get("plan_packages");
  const artifactUrls = python.globals.get("planner_artifact_urls");
  const invoke = async (value) => {
    const pending = plan(JSON.stringify(value));
    try {
      return JSON.parse(await pending);
    } finally {
      pending.destroy();
    }
  };
  const url = "https://pypi.org/pypi/snowballstemmer/json";
  try {
    await invoke({
      requirements: ["snowballstemmer"],
      constraints: [],
      artifact: {
        url,
        body: JSON.stringify({ info: { name: "snowballstemmer" }, releases: {} }),
      },
    });
    assert.deepEqual(artifactUrls().toJs(), [url]);
    const next = await invoke({
      requirements: ["snowballstemmer"],
      constraints: [],
      reset: true,
    });
    assert.equal(next.status, "fetch", "a new resolve must fetch rather than reuse prior metadata");
    assert.equal(next.url, url);
    assert.deepEqual(artifactUrls().toJs(), []);
  } finally {
    artifactUrls.destroy();
    plan.destroy();
  }
});

test("a package typo does not prevent installing bundled pandas", async () => {
  const planner = await pythonPackages();
  const tenant = await pythonPackages();
  const plan = planner.globals.get("plan_packages");
  const install = tenant.globals.get("install_packages");
  const resolver = new PackageResolver({
    create: async () => ({
      plan: async (value) => {
        const pending = plan(JSON.stringify(value));
        try {
          return JSON.parse(await pending);
        } finally {
          pending.destroy();
        }
      },
      dispose: async () => {},
    }),
    fetchImpl: async () => new Response("not found", { status: 404 }),
  });
  try {
    await assert.rejects(resolver.resolve("session", ["request"]), { code: "package_not_found" });
    const resolved = await resolver.resolve("session", ["pandas"]);
    assert.deepEqual(resolved.wheels, []);
    const pending = install(JSON.stringify(resolved));
    let result;
    try {
      result = JSON.parse(await pending);
    } finally {
      pending.destroy();
    }
    assert.equal(result.status, "ready", JSON.stringify(result));
    assert.ok(result.installed.includes("pandas==2.3.1"));
  } finally {
    await resolver.disposeSession("session");
    plan.destroy();
    install.destroy();
  }
});

test("restore rejects a missing transitive dependency from a saved wheel", async () => {
  const python = await pythonPackages();
  const install = python.globals.get("install_packages");
  try {
    const wheel = JSON.parse(
      python.runPython(`
import base64, hashlib, io, json, zipfile
buffer = io.BytesIO()
with zipfile.ZipFile(buffer, "w") as archive:
    archive.writestr("synthetic_parent-1.0.dist-info/METADATA", "Metadata-Version: 2.1\\nName: synthetic-parent\\nVersion: 1.0\\nRequires-Dist: synthetic-child>=1\\n")
    archive.writestr("synthetic_parent-1.0.dist-info/WHEEL", "Wheel-Version: 1.0\\nGenerator: nteract-test\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n")
data = buffer.getvalue()
json.dumps({"body": base64.b64encode(data).decode(), "sha256": hashlib.sha256(data).hexdigest(), "filename": "synthetic_parent-1.0-py3-none-any.whl"})
`),
    );
    const pending = install(
      JSON.stringify({
        requirements: ["synthetic-parent"],
        wheels: [{ ...wheel, name: "synthetic-parent", version: "1.0" }],
      }),
    );
    try {
      const result = JSON.parse(await pending);
      assert.equal(result.status, "error", "restore must reject its missing transitive dependency");
    } finally {
      pending.destroy();
    }
  } finally {
    install.destroy();
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
      const sessionKey = "runtime-test-session";
      const resolved = await resolver.resolve(sessionKey, ["snowballstemmer>=2,<4"]);
      assert.equal(disposed, 0, "normal resolution keeps the session-scoped planner warm");
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
      await assert.rejects(resolver.resolve(sessionKey, ["request"]), {
        code: "package_not_found",
      });
      const transitive = await resolver.resolve(sessionKey, ["requests[socks]>=2.32,<3"]);
      assert.ok(transitive.wheels.some((wheel) => wheel.name === "pysocks"));
      assert.ok(transitive.wheels.some((wheel) => wheel.name === "urllib3"));
      const transitiveResult = await invoke(install, transitive);
      assert.equal(transitiveResult.status, "ready", JSON.stringify(transitiveResult));
      const oldNotebookTenant = await pythonPackages();
      const oldNotebookInstall = oldNotebookTenant.globals.get("install_packages");
      try {
        const restored = await invoke(oldNotebookInstall, transitive);
        assert.equal(restored.status, "ready", "saved pure-wheel dependency closure restores");
        assert.ok(restored.installed.includes("requests==2.34.2"));
        assert.ok(restored.installed.includes("pysocks==1.7.1"));
      } finally {
        oldNotebookInstall.destroy();
      }
      const incomplete = await invoke(install, {
        requirements: ["not-a-real-installed-package==1"],
        wheels: [],
      });
      assert.equal(incomplete.status, "error");
      const unsatisfied = await invoke(install, { requirements: ["requests<1"], wheels: [] });
      assert.equal(unsatisfied.status, "error");
      await assert.rejects(
        resolver.resolve(sessionKey, ["requests>=2", "requests<1"]),
        /compatible|conflicts/,
      );
      assert.equal(
        await python.runPythonAsync(
          "import asyncio\nlen([task for task in asyncio.all_tasks() if task is not asyncio.current_task()])",
        ),
        0,
      );
      // Pyodide 0.28.3 bundles no PyArrow, and PyPI has no pure wheel for it.
      await assert.rejects(resolver.resolve(sessionKey, ["pyarrow"]), {
        code: "unsupported_distribution",
      });
      await assert.rejects(resolver.resolve(sessionKey, ["tensorflow"]), {
        code: "unsupported_distribution",
      });
      assert.equal(disposed, 0, "expected package errors do not dispose the warm planner");
      await resolver.disposeSession(sessionKey);
      assert.equal(disposed, 1, "closing the session disposes its planner");
    } finally {
      plan.destroy();
      install.destroy();
    }
  },
);
