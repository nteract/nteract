export function normalizeInviteEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  const parts = normalized.split("@");
  if (
    !normalized ||
    normalized.includes("/") ||
    /\s/.test(normalized) ||
    parts.length !== 2 ||
    !parts[0] ||
    !parts[1]
  ) {
    throw new Error("invite email is invalid");
  }
  return normalized;
}
