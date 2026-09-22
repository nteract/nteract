/**
 * Dependency-free people-search shapes shared by the viewer and Elements.
 * Keep auth, stores and browser services out of presentational UI imports.
 */

/** A roster ID is not an actor principal and must never seed actor profiles. */
export interface CloudDirectoryPerson {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  source: "directory";
}

export interface CloudPeopleSearchResult {
  directoryEnabled: boolean;
  requiresReverification?: boolean;
  people: readonly CloudDirectoryPerson[];
}

export interface CloudPeopleSearchState extends CloudPeopleSearchResult {
  authKey: string | null;
  query: string;
  status: "idle" | "loading" | "ready" | "error";
}
