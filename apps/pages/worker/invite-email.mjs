/** The one check of an address an invitation can name. Inviting by email
 * (sharing.mjs) and the address a sign-in provider vouches for
 * (kilo-exchange.mjs) both go through it, so a provider's address is usable
 * exactly when an invitation to it could exist. */
import { normalizeInviteEmail } from "@cloud/sharing.ts";

/** The longest address an invitation holds. */
export const MAX_INVITE_EMAIL_LENGTH = 254;

/** `value` as an invitation stores it, trimmed and lowercased, or null when it
 * can't be one: not a string, not a single address, or longer than
 * `MAX_INVITE_EMAIL_LENGTH` before or after normalizing. Lowercasing can
 * lengthen a string (U+0130 becomes two code units), so both lengths are
 * bounded.
 *
 * Invariant: whatever this returns passes it again unchanged, so
 * `inviteEmail(inviteEmail(x)) === inviteEmail(x)`. A stored invitation
 * address, or an address a provider vouched for, is always one this accepts.
 * Never throws. */
export function inviteEmail(value) {
  if (typeof value !== "string" || value.length > MAX_INVITE_EMAIL_LENGTH) return null;
  let email;
  try {
    email = normalizeInviteEmail(value);
  } catch {
    return null;
  }
  return email.length <= MAX_INVITE_EMAIL_LENGTH ? email : null;
}
