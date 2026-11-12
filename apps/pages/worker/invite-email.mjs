/** The one check of an address an invitation can name. Inviting by email
 * (sharing.mjs) and the address a sign-in provider vouches for
 * (kilo-exchange.mjs) both go through it, so a provider's address is usable
 * exactly when an invitation to it could exist. */
import { normalizeInviteEmail } from "@cloud/sharing.ts";

/** The longest address an invitation holds. */
export const MAX_INVITE_EMAIL_LENGTH = 254;

/** `value` as an invitation stores it, trimmed and lowercased, or null when it
 * can't be one: not a string, longer than `MAX_INVITE_EMAIL_LENGTH`, or not a
 * single address. Never throws. */
export function inviteEmail(value) {
  if (typeof value !== "string" || value.length > MAX_INVITE_EMAIL_LENGTH) return null;
  try {
    return normalizeInviteEmail(value);
  } catch {
    return null;
  }
}
