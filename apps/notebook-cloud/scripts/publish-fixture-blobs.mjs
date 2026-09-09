import { createHash } from "node:crypto";

const SHA256_PREFIX = "sha256:";
const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Resolve the hash a fixture blob must be uploaded under.
 *
 * The hosted blob route is content-addressed by bare lowercase sha256 hex and
 * rejects any path hash that does not equal the digest of the body. Fixture
 * manifests are expected to carry the same bare hex; an explicit `sha256:`
 * prefix is tolerated on the way in so older manifests still publish, but the
 * bytes must match the declared digest either way.
 */
export function fixtureBlobUploadHash(blob, bytes) {
  const declared = typeof blob?.hash === "string" ? blob.hash.trim() : "";
  if (declared.length === 0) {
    throw new Error("Fixture blob is missing hash");
  }
  const hash = declared.startsWith(SHA256_PREFIX) ? declared.slice(SHA256_PREFIX.length) : declared;
  if (!SHA256_HEX.test(hash)) {
    throw new Error(
      `Fixture blob ${blob.path ?? declared} hash must be sha256 hex, got ${JSON.stringify(declared)}`,
    );
  }

  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== hash) {
    throw new Error(
      `Fixture blob ${blob.path ?? declared} hash mismatch: manifest declares ${hash}, bytes digest to ${digest}`,
    );
  }
  return hash;
}
