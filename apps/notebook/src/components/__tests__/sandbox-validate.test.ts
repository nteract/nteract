/**
 * Tests for validateSandboxProfile.
 *
 * These fixtures are the shared contract between the TypeScript validator and
 * the Rust `SandboxProfile::validate()` (task 03). Any change here must be
 * reflected in the Rust tests and vice versa.
 */
import { describe, expect, it } from "vite-plus/test";
import type { SandboxProfile } from "@/sandbox/types";
import { validateSandboxProfile } from "@/sandbox/types";

const validProfile: SandboxProfile = {
  enabled: true,
  credentials: [
    {
      name: "analytics_api",
      description: "API key for analytics",
      routes: [
        {
          host: "api.analytics.example.com",
          inject_as: "header",
          header: "Authorization",
          template: "Bearer {credential}",
        },
      ],
    },
  ],
  allowed_domains: ["api.analytics.example.com"],
};

describe("validateSandboxProfile", () => {
  it("accepts a valid profile with no errors", () => {
    expect(validateSandboxProfile(validProfile)).toEqual([]);
  });

  it("accepts an empty disabled profile", () => {
    const empty: SandboxProfile = { enabled: false, credentials: [], allowed_domains: [] };
    expect(validateSandboxProfile(empty)).toEqual([]);
  });

  // Rule 1: unique names
  it("rejects duplicate credential names", () => {
    const profile: SandboxProfile = {
      ...validProfile,
      credentials: [
        { name: "key", routes: [] },
        { name: "key", routes: [] },
      ],
    };
    const errors = validateSandboxProfile(profile);
    expect(errors.some((e) => e.message.includes("Duplicate"))).toBe(true);
  });

  // Rule 2: name format
  it("rejects names starting with a digit", () => {
    const profile: SandboxProfile = {
      ...validProfile,
      credentials: [{ name: "1bad", routes: [] }],
    };
    const errors = validateSandboxProfile(profile);
    expect(errors.some((e) => e.field.includes("name"))).toBe(true);
  });

  it("rejects names with hyphens", () => {
    const profile: SandboxProfile = {
      ...validProfile,
      credentials: [{ name: "my-key", routes: [] }],
    };
    const errors = validateSandboxProfile(profile);
    expect(errors.some((e) => e.field.includes("name"))).toBe(true);
  });

  it("accepts names with underscores and digits", () => {
    const profile: SandboxProfile = {
      ...validProfile,
      credentials: [{ name: "MY_KEY_1", routes: [] }],
    };
    expect(validateSandboxProfile(profile)).toEqual([]);
  });

  // Rule 3: valid hostnames in routes
  it("rejects a route host that includes a scheme", () => {
    const profile: SandboxProfile = {
      ...validProfile,
      credentials: [
        {
          name: "key",
          routes: [
            {
              host: "https://api.example.com",
              inject_as: "header",
              header: "Authorization",
              template: "Bearer {credential}",
            },
          ],
        },
      ],
    };
    const errors = validateSandboxProfile(profile);
    expect(errors.some((e) => e.field.includes("host"))).toBe(true);
  });

  it("accepts a bare hostname in routes", () => {
    const profile: SandboxProfile = {
      ...validProfile,
      credentials: [
        {
          name: "key",
          routes: [
            {
              host: "api.example.com",
              inject_as: "header",
              header: "X-Key",
              template: "Key {credential}",
            },
          ],
        },
      ],
    };
    expect(validateSandboxProfile(profile)).toEqual([]);
  });

  // Rule 4: valid hostnames in allowed_domains
  it("rejects an allowed_domain with a path", () => {
    const profile: SandboxProfile = {
      ...validProfile,
      allowed_domains: ["example.com/api"],
    };
    const errors = validateSandboxProfile(profile);
    expect(errors.some((e) => e.field.includes("allowed_domains"))).toBe(true);
  });

  // Rule 5: header required when inject_as = "header"
  it("rejects a header injection without a header name", () => {
    const profile: SandboxProfile = {
      ...validProfile,
      credentials: [
        {
          name: "key",
          routes: [
            {
              host: "api.example.com",
              inject_as: "header",
              // header omitted
              template: "Bearer {credential}",
            },
          ],
        },
      ],
    };
    const errors = validateSandboxProfile(profile);
    expect(errors.some((e) => e.field.includes("header"))).toBe(true);
  });

  it("does not require header for basic_auth injection", () => {
    const profile: SandboxProfile = {
      ...validProfile,
      credentials: [
        {
          name: "key",
          routes: [
            {
              host: "api.example.com",
              inject_as: "basic_auth",
              template: "{credential}",
            },
          ],
        },
      ],
    };
    expect(validateSandboxProfile(profile)).toEqual([]);
  });

  // Rule 6: template must contain {credential}
  it("rejects a template missing {credential}", () => {
    const profile: SandboxProfile = {
      ...validProfile,
      credentials: [
        {
          name: "key",
          routes: [
            {
              host: "api.example.com",
              inject_as: "header",
              header: "Authorization",
              template: "Bearer TOKEN",
            },
          ],
        },
      ],
    };
    const errors = validateSandboxProfile(profile);
    expect(errors.some((e) => e.field.includes("template"))).toBe(true);
  });
});
