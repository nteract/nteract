import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { escapeHtml, scriptJsonForHtml } from "../src/index.ts";

describe("HTML script serialization", () => {
  it("escapes text and attribute metacharacters", () => {
    assert.equal(escapeHtml(`<&>"'`), "&lt;&amp;&gt;&quot;&#x27;");
  });

  it("escapes script-breaking characters", () => {
    const serialized = scriptJsonForHtml("</script><img src=x onerror=alert(1)>");

    assert.equal(serialized.includes("</script>"), false);
    assert.equal(serialized.includes("<img"), false);
    assert.equal(serialized, '"\\u003c/script\\u003e\\u003cimg src=x onerror=alert(1)\\u003e"');
  });
});
