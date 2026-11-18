// @vitest-environment node
import { describe, expect, it } from "vite-plus/test";
import { normalizeInviteEmail } from "../src/index";

describe("normalizeInviteEmail", () => {
  it("trims and lowercases the invite lookup email", () => {
    expect(normalizeInviteEmail(" Alice@Example.COM ")).toBe("alice@example.com");
  });

  it("rejects structurally invalid invite emails", () => {
    for (const email of [
      "",
      "   ",
      "@@",
      "a@b@c",
      "@example.com",
      "alice@",
      "a/b@example.com",
      "a b@example.com",
    ]) {
      expect(() => normalizeInviteEmail(email)).toThrow(/invite email is invalid/);
    }
  });
});
