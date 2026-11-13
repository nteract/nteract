// Starts escape Workers for scripts/chart-smoke.mjs and records what each
// reached: a Worker with no lockdown and no CSP ("control"), the real chart
// Worker under its own CSP ("both"), the same script with no CSP
// ("lockdown"), and a Worker with no lockdown under the chart Worker's CSP
// ("csp"). Built by the smoke; never part of the viewer build.
const VARIANTS = {
  control: "/open/escape-bare-worker.js",
  both: "/escape-worker.js",
  lockdown: "/open/escape-worker.js",
  csp: "/escape-bare-worker.js",
};

window.escapes = {};
for (const [name, url] of Object.entries(VARIANTS)) {
  const worker = new Worker(url, { name: `escape-${name}` });
  window.escapes[name] = await new Promise((resolve) => {
    worker.addEventListener("message", ({ data }) => {
      if (data?.type === "escaped") resolve({ results: data.results, remaining: data.remaining });
    });
    worker.addEventListener("error", (event) => resolve({ error: event.message || "error" }));
    worker.postMessage({ type: "escape", variant: name });
  });
  worker.terminate();
}
document.body.dataset.fixture = "ready";
