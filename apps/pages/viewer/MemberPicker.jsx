import { useEffect, useId, useMemo, useState, useSyncExternalStore } from "react";
import { createMemberSearch, MAX_MEMBER_QUERY } from "./member-search.mjs";
import { ROLE_LABELS } from "./sharing-roles.mjs";

/** Up to two initials from a name, for a person without an avatar. */
export function initials(name) {
  const words = String(name ?? "")
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  const letters = words.length > 1 ? [words[0], words.at(-1)] : words.slice(0, 1);
  return letters.map((word) => [...word][0].toUpperCase()).join("");
}

/** A member's avatar, or their initials when there is none or it fails to
 * load. The image is requested without a referrer, so the avatar's host
 * doesn't learn which Page is open. */
function Avatar({ name, imageUrl }) {
  const [broken, setBroken] = useState(false);
  return imageUrl && !broken ? (
    <img
      className="member-picker-avatar"
      src={imageUrl}
      alt=""
      referrerPolicy="no-referrer"
      loading="lazy"
      decoding="async"
      onError={() => setBroken(true)}
    />
  ) : (
    <span className="member-picker-avatar member-picker-initials" aria-hidden="true">
      {initials(name)}
    </span>
  );
}

/** What the status line says for a search state. */
export function memberSearchStatus(state, organizationName) {
  if (state.name === "searching") return "Searching…";
  if (state.name === "results")
    return state.members.length
      ? `${state.members.length} ${state.members.length === 1 ? "person" : "people"} found.`
      : `No one in ${organizationName} matches.`;
  if (state.name === "failed")
    return state.rateLimited
      ? "Too many searches. Wait a moment, then keep typing."
      : state.unavailable
        ? `Searching ${organizationName} isn't available right now. Keep typing to try again, or invite by email.`
        : "Search failed. Keep typing to try again.";
  if (state.name === "limited")
    return `Too many searches. Searching again in ${Math.ceil(state.retryAfterMs / 1000)} seconds.`;
  if (state.name === "signin")
    return `Sign in again to search ${organizationName}. Then keep typing.`;
  return "";
}

/**
 * Add people by name from one of the owner's organizations. `organizations`
 * are the owner's organizations now (`organizationOptions`); with more than
 * one, a select chooses which to search, starting at `preferred` (the
 * organization the Page or Project is shared with) when the owner belongs to
 * it. `onGrant({ organization_id,
 * member_id, role })` sends the sharing change and resolves true once it is
 * applied; the host asks the directory again before granting, so the name
 * shown here is never what is granted. `busy` disables picking while another
 * change runs. Renders nothing once the deployment turns out to have no
 * organization search, so sharing by email is what remains; a directory
 * outage only fails that search. `search` replaces the host request in tests.
 */
export function MemberPicker({ organizations, preferred, busy, onGrant, search }) {
  const id = useId();
  const picker = useMemo(() => createMemberSearch(search ? { search } : {}), [search]);
  useEffect(() => () => picker.dispose(), [picker]);
  const state = useSyncExternalStore((listener) => {
    const subscription = picker.state$.subscribe(listener);
    return () => subscription.unsubscribe();
  }, picker.getState);
  const [chosen, setChosen] = useState(() =>
    organizations.some(({ id: value }) => value === preferred)
      ? preferred
      : (organizations[0]?.id ?? ""),
  );
  const [query, setQuery] = useState("");
  const [role, setRole] = useState("viewer");
  const [granting, setGranting] = useState(null);
  const organization =
    organizations.find((candidate) => candidate.id === chosen) ?? organizations[0];
  if (!organization || state.name === "unavailable") return null;
  const type = (organizationId, value) => {
    setQuery(value);
    picker.type(organizationId, value);
  };
  async function grant(member) {
    if (busy || granting) return;
    setGranting(member.id);
    try {
      const done = await onGrant({
        organization_id: organization.id,
        member_id: member.id,
        role,
      });
      if (done) {
        setQuery("");
        picker.reset();
      }
    } finally {
      setGranting(null);
    }
  }
  const members = state.name === "results" ? state.members : [];
  const status = memberSearchStatus(state, organization.name);
  return (
    <section className="member-picker" aria-labelledby={`${id}-label`}>
      <label id={`${id}-label`} htmlFor={`${id}-query`}>
        Add people from your organization
      </label>
      {organizations.length > 1 && (
        <select
          aria-label="Organization to search"
          value={organization.id}
          onChange={(event) => {
            setChosen(event.target.value);
            type(event.target.value, query);
          }}
        >
          {organizations.map(({ id: value, name }) => (
            <option key={value} value={value}>
              {name}
            </option>
          ))}
        </select>
      )}
      <div className="member-picker-row">
        <input
          id={`${id}-query`}
          type="search"
          value={query}
          maxLength={MAX_MEMBER_QUERY}
          autoComplete="off"
          spellCheck={false}
          placeholder={`Search ${organization.name} by name`}
          aria-describedby={`${id}-status`}
          aria-controls={`${id}-results`}
          onChange={(event) => type(organization.id, event.target.value)}
        />
        <select
          aria-label="Access for the person you add"
          value={role}
          onChange={(event) => setRole(event.target.value)}
        >
          {Object.entries(ROLE_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <p id={`${id}-status`} className="member-picker-status" role="status" aria-live="polite">
        {status}
        {state.name === "signin" && (
          <>
            {" "}
            <a href="/api/auth/login" target="_blank" rel="noopener noreferrer">
              Sign in again
            </a>
          </>
        )}
      </p>
      <ul id={`${id}-results`} className="member-picker-results" aria-label="People found">
        {members.map((member) => (
          <li key={member.id}>
            <button
              type="button"
              disabled={!!busy || !!granting}
              aria-label={`Add ${member.name}, ${ROLE_LABELS[role]}`}
              onClick={() => void grant(member)}
            >
              <Avatar name={member.name} imageUrl={member.imageUrl} />
              <span className="member-picker-name">{member.name}</span>
              <span className="member-picker-add" aria-hidden="true">
                {granting === member.id ? "Adding…" : "Add"}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
