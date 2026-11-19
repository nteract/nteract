import assert from "node:assert/strict";
import { test } from "node:test";
import { FRAME_CSP } from "../output/policy.mjs";
import { localFrameCsp } from "./local-frame-csp.mjs";

const directive = (csp, name) => csp.split("; ").find((part) => part.startsWith(name + " "));

test("a local frame CSP adds the local Pages origin to scripts and styles only", () => {
  for (const origin of ["http://localhost:9894", "http://127.0.0.1:9916", "http://[::1]:9894"]) {
    const csp = localFrameCsp(origin);
    assert.equal(directive(csp, "script-src"), directive(FRAME_CSP, "script-src") + " " + origin);
    assert.equal(directive(csp, "style-src"), directive(FRAME_CSP, "style-src") + " " + origin);
    // Every other directive is the production policy's.
    const others = (policy) =>
      policy.split("; ").filter((part) => !/^(script|style)-src /.test(part));
    assert.deepEqual(others(csp), others(FRAME_CSP));
  }
  // An https Pages origin is already admitted.
  assert.equal(localFrameCsp("https://pages.example"), FRAME_CSP);
});

test("a local frame CSP admits no other origin", () => {
  for (const origin of [
    "http://pages.example",
    "http://localhost:9894/",
    "http://localhost:9894/p/x",
    "ftp://localhost",
  ])
    assert.throws(() => localFrameCsp(origin), /origin/i, origin);
});

test("the production frame CSP admits library modules over https only", () => {
  assert.match(
    directive(FRAME_CSP, "script-src"),
    /^script-src 'unsafe-inline' 'wasm-unsafe-eval' https: blob:$/,
  );
});
