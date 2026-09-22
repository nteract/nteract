import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { CloudStoresProvider, useCloudStores } from "../cloud-stores-context";
import { CloudUserStore } from "../cloud-user-store";
import { fetchWithCloudPrototypeAuth, type CloudPrototypeAuthState } from "../collaborator-auth";
import { CloudSharingControls } from "../sharing-controls";

vi.mock("../collaborator-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../collaborator-auth")>()),
  fetchWithCloudPrototypeAuth: vi.fn(),
}));

const AUTH: CloudPrototypeAuthState = {
  mode: "oidc",
  token: "session-a",
  user: "owner@example.test",
  oidcClaims: { sub: "owner-a", email: "owner@example.test", email_verified: true },
  requestedScope: "owner",
  problem: null,
};
const PERSON = {
  id: "opaque-roster-a",
  displayName: "Alice Example",
  avatarUrl: null,
  source: "directory",
};

function Sharing({ user, auth = AUTH }: { user: CloudUserStore; auth?: CloudPrototypeAuthState }) {
  const stores = useCloudStores();
  return (
    <CloudStoresProvider stores={{ ...stores, user }}>
      <CloudSharingControls
        authState={auth}
        aclEndpoint="/api/n/example/acl"
        invitesEndpoint="/api/n/example/invites"
        accessRequestsEndpoint="/api/n/example/access-requests"
        publicLink="https://notebooks.example.test/n/example"
      />
    </CloudStoresProvider>
  );
}

function mockApi(directoryEnabled: boolean, inviteFailure = false) {
  const posts: unknown[] = [];
  const requests: string[] = [];
  vi.mocked(fetchWithCloudPrototypeAuth).mockImplementation(async (input, init) => {
    const url = String(input);
    requests.push(url);
    if (url.startsWith("/api/people?")) {
      return Response.json({
        directoryEnabled,
        people: directoryEnabled && url.endsWith("=ali") ? [PERSON] : [],
      });
    }
    if (init?.method === "POST") {
      posts.push(JSON.parse(String(init.body)));
      return inviteFailure
        ? Response.json({ error: "directory person is unavailable" }, { status: 404 })
        : Response.json({});
    }
    return Response.json({ acl: [], invites: [], access_requests: [] });
  });
  return { posts, requests };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("sharing people discovery", () => {
  it("keeps the default full-email invitation without directory suggestions", async () => {
    const api = mockApi(false);
    render(<Sharing user={new CloudUserStore()} />);
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    const field = screen.getByLabelText("Invite by email");
    await waitFor(() =>
      expect(api.requests.filter((url) => url.startsWith("/api/people"))).toHaveLength(1),
    );
    fireEvent.change(field, { target: { value: "recipient@example.test" } });
    expect(screen.queryByLabelText("Company directory results")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Invite" }));
    await waitFor(() =>
      expect(api.posts).toEqual([{ email: "recipient@example.test", scope: "viewer" }]),
    );
    expect(api.requests.filter((url) => url.startsWith("/api/people"))).toHaveLength(1);
  });

  it("requires a result selection and an explicit invite, sending only its opaque ID", async () => {
    const api = mockApi(true);
    render(<Sharing user={new CloudUserStore()} />);
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    const field = await screen.findByLabelText("Name or email");
    fireEvent.change(field, { target: { value: "Ali" } });
    const person = await screen.findByRole("button", { name: "Select Alice Example" });
    expect(screen.getByRole("button", { name: "Invite" })).toHaveProperty("disabled", true);
    fireEvent.click(person);
    expect(api.posts).toEqual([]);
    expect(screen.getByText(/Alice Example selected/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Invite" }));
    await waitFor(() =>
      expect(api.posts).toEqual([{ directoryPersonId: "opaque-roster-a", scope: "viewer" }]),
    );
    expect(await screen.findByText("Invite created for Alice Example.")).toBeTruthy();
  });

  it("surfaces policy removal without granting access or enumerating another identity", async () => {
    const api = mockApi(true, true);
    render(<Sharing user={new CloudUserStore()} />);
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    fireEvent.change(await screen.findByLabelText("Name or email"), { target: { value: "Ali" } });
    fireEvent.click(await screen.findByRole("button", { name: "Select Alice Example" }));
    fireEvent.click(screen.getByRole("button", { name: "Invite" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "directory person is unavailable",
    );
    expect(api.posts).toHaveLength(1);
    expect(screen.queryByText(/Invite created/)).toBeNull();
  });

  it("discards selected directory people when the account changes", async () => {
    const api = mockApi(true);
    const user = new CloudUserStore();
    const view = render(<Sharing user={user} />);
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    fireEvent.change(await screen.findByLabelText("Name or email"), { target: { value: "Ali" } });
    fireEvent.click(await screen.findByRole("button", { name: "Select Alice Example" }));
    view.rerender(
      <Sharing user={user} auth={{ ...AUTH, token: "session-b", user: "other@example.test" }} />,
    );
    expect(screen.queryByText(/Alice Example selected/)).toBeNull();
    expect(screen.getByRole("button", { name: "Invite" })).toHaveProperty("disabled", true);
    expect(api.posts).toEqual([]);
  });
});
