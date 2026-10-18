import { object, requireValue } from "./errors.ts";

// Only use this for names received from the authenticated server session or
// server frames. Client presence positions never supply identity.
export function presenceDisplayName(value: unknown): string | null {
  return typeof value === "string" ? value.trim().slice(0, 160) || null : null;
}
export interface Presence {
  block_id: string;
  start: string;
  end: string;
  backward: boolean;
  heads: string[];
}
export function presence(value: unknown): Presence | null {
  if (value === null) return null;
  const v = object(value);
  requireValue(
    typeof v.block_id === "string" && /^[a-f0-9-]{36}$/.test(v.block_id),
    "invalid_presence",
    "Invalid presence block",
  );
  for (const key of ["start", "end"])
    requireValue(
      typeof v[key] === "string" && v[key].length <= 256,
      "invalid_presence",
      "Invalid presence cursor",
    );
  requireValue(
    typeof v.backward === "boolean" &&
      Array.isArray(v.heads) &&
      v.heads.length <= 32 &&
      v.heads.every((h) => typeof h === "string" && /^[a-f0-9]{64}$/.test(h)),
    "invalid_presence",
    "Invalid presence position",
  );
  return {
    block_id: v.block_id,
    start: v.start as string,
    end: v.end as string,
    backward: v.backward,
    heads: v.heads,
  };
}
