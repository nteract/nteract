import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Env, ExecutionContext } from "../src/cloudflare-types.ts";
import {
  dispatchWorkerRoute,
  exactPath,
  routePath,
  type WorkerRoute,
} from "../src/worker-routing.ts";

const env = {} as Env;
const ctx: ExecutionContext = {
  waitUntil() {},
  passThroughOnException() {},
};

describe("worker route dispatcher", () => {
  it("dispatches the first matching route", async () => {
    const routes: WorkerRoute[] = [
      {
        match: routePath("/api/n/:notebookId"),
        handler: () => new Response("catalog"),
      },
      {
        match: routePath("/api/n/:notebookId"),
        handler: () => new Response("duplicate"),
      },
    ];

    const response = await dispatchWorkerRoute(
      routes,
      new Request("https://cloud.test/api/n/topic-viz"),
      env,
      ctx,
    );

    assert.equal(await response?.text(), "catalog");
  });

  it("skips method-filtered routes without turning fallthroughs into 405s", async () => {
    const routes: WorkerRoute[] = [
      {
        match: exactPath("/"),
        methods: ["GET"],
        handler: () => new Response("home"),
      },
    ];

    const response = await dispatchWorkerRoute(
      routes,
      new Request("https://cloud.test/", { method: "POST" }),
      env,
      ctx,
    );

    assert.equal(response, null);
  });

  it("decodes captured route parameters at the edge", async () => {
    const routes: WorkerRoute[] = [
      {
        match: routePath("/n/:notebookId/r/:revision"),
        handler: ({ params }) =>
          Response.json({
            notebookId: params.notebookId,
            revision: params.revision,
          }),
      },
    ];

    const response = await dispatchWorkerRoute(
      routes,
      new Request("https://cloud.test/n/demo%20notebook/r/heads%2Fpinned"),
      env,
      ctx,
    );

    assert.deepEqual(await response?.json(), {
      notebookId: "demo notebook",
      revision: "heads/pinned",
    });
  });

  it("matches routes with optional trailing slashes", async () => {
    const routes: WorkerRoute[] = [
      {
        match: routePath("/api/n/:notebookId/acl", { trailingSlash: "optional" }),
        handler: ({ params }) => new Response(params.notebookId),
      },
    ];

    const response = await dispatchWorkerRoute(
      routes,
      new Request("https://cloud.test/api/n/topic-viz/acl/"),
      env,
      ctx,
    );

    assert.equal(await response?.text(), "topic-viz");
  });
});
