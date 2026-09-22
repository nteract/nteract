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

function mockApi(directoryEnabled: boolean, inviteFailure = false, requiresReverification = false) {
  const posts: unknown[] = [];
  const requests: string[] = [];
  vi.mocked(fetchWithCloudPrototypeAuth).mockImplementation(async (input, init) => {
    const url = String(input);
    requests.push(url);
    if (url.startsWith("/api/people?")) {
      return Response.json({
        directoryEnabled,
        ...(requiresReverification ? { requiresReverification: true } : {}),
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
  function collaboratorApi() {
    let hidden = false;
    const posts: { url: string; body: unknown }[] = [];
    const requests: string[] = [];
    vi.mocked(fetchWithCloudPrototypeAuth).mockImplementation(async (input, init) => {
      const url = String(input);
      requests.push(url);
      if (url === "/api/people/hidden" && init?.method === "POST") {
        posts.push({ url, body: JSON.parse(String(init.body)) });
        hidden = true;
        return Response.json({ id: "hidden-a" });
      }
      if (url.startsWith("/api/people/hidden/") && init?.method === "DELETE") {
        hidden = false;
        return new Response(null, { status: 204 });
      }
      if (url.startsWith("/api/people/hidden")) {
        return Response.json({
          hidden: [
            { id: "hidden-a", personId: PERSON.id, displayName: "Hidden person", avatarUrl: null },
          ],
          nextCursor: null,
        });
      }
      if (url.startsWith("/api/people?")) {
        return Response.json({
          directoryEnabled: false,
          collaboratorsEnabled: true,
          people: hidden ? [] : [{ ...PERSON, source: "collaborator" }],
        });
      }
      if (init?.method === "POST") {
        posts.push({ url, body: JSON.parse(String(init.body)) });
        return Response.json({});
      }
      return Response.json({ acl: [], invites: [], access_requests: [] });
    });
    return { posts, requests };
  }

  it("shares with an eligible collaborator only after explicit selection and confirmation", async () => {
    const api = collaboratorApi();
    render(<Sharing user={new CloudUserStore()} />);
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    fireEvent.click(await screen.findByRole("button", { name: "Select Alice Example" }));
    expect(api.posts).toEqual([]);
    expect(screen.queryByLabelText("Company directory results")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Share with Alice Example" }));
    await waitFor(() =>
      expect(api.posts).toEqual([
        { url: "/api/n/example/acl", body: { collaboratorPersonId: PERSON.id, scope: "viewer" } },
      ]),
    );
    expect(await screen.findByText("Alice Example can now view this notebook.")).toBeTruthy();
    expect(api.requests.filter((url) => url.startsWith("/api/people/hidden"))).toHaveLength(0);
  });

  it("hides both-way suggestions with inline undo without changing notebook access", async () => {
    const api = collaboratorApi();
    render(<Sharing user={new CloudUserStore()} />);
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Hide collaboration suggestion for Alice Example",
      }),
    );
    expect(
      await screen.findByText(/Collaboration suggestions between you and Alice Example are hidden/),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Select Alice Example" })).toBeNull();
    expect(api.posts).toEqual([{ url: "/api/people/hidden", body: { personId: PERSON.id } }]);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(await screen.findByRole("button", { name: "Select Alice Example" })).toBeTruthy();
    expect(screen.queryByText(/Collaboration suggestions between/)).toBeNull();
    expect(api.posts.some((post) => post.url.includes("/api/n/"))).toBe(false);
    expect(api.requests.filter((url) => url.startsWith("/api/people?q="))).toHaveLength(3);
  });

  it("loads hidden suggestions only on demand and can undo a generic hidden person", async () => {
    const api = collaboratorApi();
    render(<Sharing user={new CloudUserStore()} />);
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    const disclosure = await screen.findByRole("button", { name: "Hidden suggestions" });
    expect(api.requests.filter((url) => url.startsWith("/api/people/hidden"))).toHaveLength(0);
    fireEvent.click(disclosure);
    expect(await screen.findByText("Hidden person")).toBeTruthy();
    expect(screen.queryByText("hidden-a")).toBeNull();
    expect(screen.queryByText(PERSON.id)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Undo hiding Hidden person" }));
    await waitFor(() => expect(api.requests).toContain("/api/people/hidden/hidden-a"));
    expect(api.posts).toEqual([]);
  });

  it("explains reverification without extra auth calls and clears the hint on account change", async () => {
    const api = mockApi(false, false, true);
    const user = new CloudUserStore();
    const view = render(<Sharing user={user} />);
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    expect(await screen.findByText(/Sign in again to search the company directory/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Invite by email"), {
      target: { value: "recipient@example.test" },
    });
    expect(screen.getByRole("button", { name: "Invite" })).toHaveProperty("disabled", false);
    expect(api.requests.filter((url) => url.startsWith("/api/people"))).toHaveLength(1);
    expect(
      api.requests.every((url) => url.startsWith("/api/n/") || url.startsWith("/api/people?")),
    ).toBe(true);
    mockApi(false);
    view.rerender(
      <Sharing user={user} auth={{ ...AUTH, token: "session-b", user: "other@example.test" }} />,
    );
    expect(screen.queryByText(/Sign in again to search the company directory/)).toBeNull();
  });

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
