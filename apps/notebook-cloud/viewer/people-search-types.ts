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

export interface CloudCollaboratorPerson {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  source: "collaborator";
}

export type CloudSearchPerson = CloudDirectoryPerson | CloudCollaboratorPerson;

export interface CloudHiddenPerson {
  id: string;
  personId: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface CloudHiddenPeopleState {
  authKey: string | null;
  hidden: readonly CloudHiddenPerson[];
  nextCursor: string | null;
  status: "idle" | "loading" | "ready" | "error";
  busyId: string | null;
  error: string | null;
  lastHidden: CloudHiddenPerson | null;
}

export interface CloudPeopleSearchResult {
  directoryEnabled: boolean;
  collaboratorsEnabled?: boolean;
  requiresReverification?: boolean;
  people: readonly CloudSearchPerson[];
}

export interface CloudPeopleSearchState extends CloudPeopleSearchResult {
  authKey: string | null;
  query: string;
  status: "idle" | "loading" | "ready" | "error";
}
