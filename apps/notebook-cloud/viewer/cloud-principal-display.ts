/**
 * Principal-display helpers shared by cloud viewer surfaces that must not show
 * opaque subject identifiers before the user directory resolves a real name.
 */

// A principal subject that is only an identifier - a UUID, ULID, or long hex
// room/subject id - has no human reading, so it must never be rendered as a
// name. Resolving these to real display names is the cloud user store's job.
export function cloudPrincipalSubjectIsOpaque(subject: string): boolean {
  return (
    /^[0-9a-f]{12,}$/iu.test(subject) ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(subject) ||
    /^[0-9A-HJKMNP-TV-Z]{26}$/iu.test(subject)
  );
}
