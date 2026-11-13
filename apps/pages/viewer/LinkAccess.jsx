import { useId } from "react";
import { ROLE_LABELS } from "./sharing-roles.mjs";

const roleLabel = (role) => ROLE_LABELS[role] ?? ROLE_LABELS.viewer;

/**
 * The owner's "Link access" control for a Page or a Project: Restricted, then
 * each organization, then each company domain, from `linkAccess`
 * (`linkAccessProjection` in sharing-projection.mjs), and the role the stored
 * audience gives. `resource` names what is shared ("Page" or "Project").
 * `onChange` receives the sharing action to send: choosing an audience sets
 * it at the stored audience's role or Can view, choosing a role sets it on
 * the stored audience, and Restricted clears whichever audience is stored.
 * `onRefresh` reads sharing again after the owner signs in again in another
 * tab.
 */
export function LinkAccess({ linkAccess, resource, busy, refreshing, onChange, onRefresh }) {
  const id = useId();
  const grant = (option, role) =>
    option.kind === "domain"
      ? { action: "set_domain_view", domain: option.value, role }
      : { action: "set_organization_access", organization_id: option.id, role };
  function choose(selected) {
    const option = linkAccess.options.find((candidate) => candidate.value === selected);
    if (!option?.kind)
      return onChange(
        linkAccess.organization
          ? { action: "set_organization_access", organization_id: null }
          : { action: "set_domain_view", domain: null },
      );
    onChange(grant(option, linkAccess.role ?? "viewer"));
  }
  function chooseRole(role) {
    const option = linkAccess.options.find((candidate) => candidate.value === linkAccess.selected);
    if (option?.kind) onChange(grant(option, role));
  }
  return (
    <section className="page-domain-sharing" aria-labelledby={id}>
      <label id={id} htmlFor={`${id}-select`}>
        Link access
      </label>
      <select
        id={`${id}-select`}
        value={linkAccess.selected}
        disabled={busy}
        onChange={(event) => choose(event.target.value)}
      >
        {linkAccess.options.map(({ value, label, disabled }) => (
          <option key={value} value={value} disabled={disabled}>
            {label}
          </option>
        ))}
      </select>
      {linkAccess.role && (
        <>
          <label htmlFor={`${id}-role`}>
            {linkAccess.organization ? "Members can" : "People can"}
          </label>
          <select
            id={`${id}-role`}
            className="page-organization-role"
            value={linkAccess.role}
            disabled={busy || linkAccess.unverified}
            onChange={(event) => chooseRole(event.target.value)}
          >
            {Object.entries(ROLE_LABELS).map(([role, label]) => (
              <option key={role} value={role}>
                {label}
              </option>
            ))}
          </select>
        </>
      )}
      <p>
        {linkAccess.organization ? (
          <>
            <strong>{roleLabel(linkAccess.organization.role)}.</strong> Members of{" "}
            {linkAccess.organization.name} who sign in can open the link. They are not added to the
            people list.
          </>
        ) : linkAccess.domain ? (
          <>
            <strong>{roleLabel(linkAccess.role)}.</strong> People who sign in with a verified{" "}
            {linkAccess.domain} email can open the link. They are not added to the people list.
          </>
        ) : (
          `Only you and invited people can open this ${resource}.`
        )}
      </p>
      {linkAccess.expired ? (
        <div className="page-domain-sharing-note" role="note">
          <p>
            {linkAccess.expired.kind === "domain"
              ? "Your company email verification expired. Sign in again with the same account to enable company sharing."
              : `Your membership in ${linkAccess.expired.name} needs confirming. Sign in again with the same account to change this sharing.`}
          </p>
          {linkAccess.unverified && (
            <p>
              {linkAccess.organization
                ? `Members of ${linkAccess.organization.name} can still open this ${resource}.`
                : `People at ${linkAccess.domain} can still open this ${resource}.`}{" "}
              Choose Restricted to stop sharing with them.
            </p>
          )}
          <div className="page-domain-sharing-actions">
            {/* The same sign-in the session uses; a separate tab keeps
                this one open and its edits running. */}
            <a href="/api/auth/login" target="_blank" rel="noopener noreferrer">
              Sign in again
            </a>
            <button
              type="button"
              className="subtle-button"
              disabled={refreshing || busy}
              onClick={onRefresh}
            >
              Refresh sharing settings
            </button>
          </div>
        </div>
      ) : (
        linkAccess.unverified &&
        (linkAccess.organization ? (
          <p className="page-domain-sharing-note" role="note">
            You are not a member of {linkAccess.organization.name} now. Its members can still open
            this {resource}. Choose Restricted to stop sharing with them; sharing again needs
            membership in {linkAccess.organization.name}.
          </p>
        ) : (
          <p className="page-domain-sharing-note" role="note">
            You are not signed in with a verified {linkAccess.domain} email. People at{" "}
            {linkAccess.domain} can still open this {resource}. Choose Restricted to stop sharing
            with them; sharing again needs a verified {linkAccess.domain} email.
          </p>
        ))
      )}
    </section>
  );
}
