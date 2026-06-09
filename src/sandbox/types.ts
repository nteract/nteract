/**
 * SandboxProfile — TypeScript mirror of the Rust `SandboxProfile` type from
 * `crates/notebook-doc/src/sandbox.rs` (task 03).
 *
 * These types live in `src/` (shared) so both the notebook app and any future
 * host can import them without creating a circular dependency.
 *
 * **Keep in sync with the Rust schema.** The validation rules below are a
 * TypeScript re-implementation of `SandboxProfile::validate()` in Rust; the
 * shared fixture test suite (see `__tests__/sandbox-validate.test.ts`) ensures
 * they agree on every valid/invalid profile.
 */

// ── Types ─────────────────────────────────────────────────────────────────

export type InjectionKind = "header" | "basic_auth" | "query";

export interface RouteRule {
  /** Hostname only — no scheme, no path. Example: `api.example.com` */
  host: string;
  inject_as: InjectionKind;
  /** Required when inject_as === "header". */
  header?: string;
  /** Must contain the literal substring `{credential}`. */
  template: string;
}

export interface CredentialRef {
  /** Stable identifier. Matches `^[a-zA-Z][a-zA-Z0-9_-]*$`. */
  name: string;
  description?: string;
  env_var?: string;
  keystore_name?: string;
  routes: RouteRule[];
}

export interface SandboxProfile {
  enabled: boolean;
  credentials: CredentialRef[];
  allowed_domains: string[];
}

// ── Validation ────────────────────────────────────────────────────────────

export interface ProfileValidationError {
  field: string;
  message: string;
}

/** `^[a-zA-Z][a-zA-Z0-9_-]*$` — matches the Rust regex used in task 03. */
const CREDENTIAL_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

/**
 * Validate a hostname: no scheme, no path, no port, no whitespace.
 * A bare IP address or dotted hostname is accepted; an empty string is not.
 */
function isValidHostname(host: string): boolean {
  if (!host || host.includes("/") || host.includes(" ")) return false;
  // Strip a leading wildcard like `*.example.com`
  const bare = host.startsWith("*.") ? host.slice(2) : host;
  // Each label: 1-63 chars, alphanumeric + hyphen, not starting/ending with hyphen
  const labelRe = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
  return bare.split(".").every((label) => label.length > 0 && labelRe.test(label));
}

/**
 * Client-side validator — mirrors `SandboxProfile::validate()` in Rust.
 *
 * Returns an array of errors; empty array means the profile is valid.
 *
 * Rules (must match the Rust validator exactly):
 * 1. All credential `name` values must be unique.
 * 2. All `name` values must match `^[a-zA-Z][a-zA-Z0-9_-]*$`.
 * 3. All `host` values in routes must be valid hostnames (no scheme, no path).
 * 4. `allowed_domains` entries must be valid hostnames.
 * 5. Each `RouteRule` with `inject_as = "header"` must set `header`.
 * 6. Each `template` must contain the literal substring `{credential}`.
 */
export function validateSandboxProfile(
  profile: SandboxProfile
): ProfileValidationError[] {
  const errors: ProfileValidationError[] = [];

  // Rule 1: unique credential names
  const names = profile.credentials.map((c) => c.name);
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) {
      errors.push({
        field: `credentials.${name}.name`,
        message: `Duplicate credential name: \`${name}\`.`,
      });
    }
    seen.add(name);
  }

  for (let ci = 0; ci < profile.credentials.length; ci++) {
    const cred = profile.credentials[ci];

    // Rule 2: name format
    if (!CREDENTIAL_NAME_RE.test(cred.name)) {
      errors.push({
        field: `credentials[${ci}].name`,
        message: `Credential name \`${cred.name}\` must match ^[a-zA-Z][a-zA-Z0-9_-]*$.`,
      });
    }

    for (let ri = 0; ri < cred.routes.length; ri++) {
      const route = cred.routes[ri];
      const routeField = `credentials[${ci}].routes[${ri}]`;

      // Rule 3: valid hostname in routes
      if (!isValidHostname(route.host)) {
        errors.push({
          field: `${routeField}.host`,
          message: `\`${route.host}\` is not a valid hostname (no scheme or path allowed).`,
        });
      }

      // Rule 5: header required when inject_as = "header"
      if (route.inject_as === "header" && !route.header) {
        errors.push({
          field: `${routeField}.header`,
          message: `Header name is required when injection type is "header".`,
        });
      }

      // Rule 6: template must contain {credential}
      if (!route.template.includes("{credential}")) {
        errors.push({
          field: `${routeField}.template`,
          message: `Template must contain the literal \`{credential}\`.`,
        });
      }
    }
  }

  // Rule 4: valid hostnames in allowed_domains
  for (let di = 0; di < profile.allowed_domains.length; di++) {
    const domain = profile.allowed_domains[di];
    if (!isValidHostname(domain)) {
      errors.push({
        field: `allowed_domains[${di}]`,
        message: `\`${domain}\` is not a valid hostname.`,
      });
    }
  }

  return errors;
}

/** Convenience: returns true when the profile has no validation errors. */
export function isSandboxProfileValid(profile: SandboxProfile): boolean {
  return validateSandboxProfile(profile).length === 0;
}

/** Empty profile matching the default opt-in-disabled state. */
export function emptySandboxProfile(): SandboxProfile {
  return { enabled: false, credentials: [], allowed_domains: [] };
}
