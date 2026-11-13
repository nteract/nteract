/** A stand-in for PlainSync (plain-sync.mjs) in Page host fixtures that bring
 * their own repo and handles. It flushes through `repo` and serves no
 * sockets; `overrides` replaces any member. Tests that need real sync boot a
 * Page host or use sync/plain-host-fixture.mjs. */
export function plainStub(repo, overrides = {}) {
  return {
    hostActorPrefix: undefined,
    async flush(documentIds) {
      await repo?.flush?.(documentIds);
    },
    refresh() {},
    disconnectAll() {},
    async forget() {},
    serve() {},
    profiles: () => ({}),
    claim: () => undefined,
    actorSnapshot: () => ({ actorProfiles: {}, attestedChanges: {} }),
    sender: (_identity, requested) => ({ senderId: requested ?? "b-fixture", replaces: null }),
    async close() {},
    ...overrides,
  };
}
