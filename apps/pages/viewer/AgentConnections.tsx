import { useEffect, useState } from "react";
import type { AgentGrant } from "../src/agent-access.ts";

type Approval = { token_hash: string; driver: string; page_id: string; permissions: string[] };
export function AgentConnections() {
  const [session, setSession] = useState<{ display_name?: string } | null | undefined>(undefined);
  const [connections, setConnections] = useState<AgentGrant[]>([]);
  const [request, setRequest] = useState<Approval | null>(null);
  const [title, setTitle] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [approved, setApproved] = useState(false);
  const [lifetime, setLifetime] = useState(3600);
  async function api(path: string, method = "GET", body?: unknown) {
    const response = await fetch(path, {
      method,
      ...(body
        ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
        : {}),
    });
    const value = await response.json();
    if (!response.ok) throw Error(value.error?.message ?? "Connection request failed");
    return value;
  }
  useEffect(() => {
    let alive = true;
    void (async () => {
      const auth = await api("/api/auth/session");
      if (!alive) return;
      setSession(auth.session);
      if (!auth.session) return;
      const value = await api("/api/agent-connections");
      if (!alive) return;
      setConnections(value.connections);
      const encoded = new URL(location.href).searchParams.get("connect");
      if (!encoded) return;
      if (encoded.length > 2000) throw Error("Invalid connection request");
      const data = JSON.parse(encoded) as Approval;
      if (
        !/^[a-f0-9]{64}$/.test(data.token_hash) ||
        !/^page_[a-f0-9]{32}$/.test(data.page_id) ||
        typeof data.driver !== "string" ||
        !data.driver.trim() ||
        data.driver.length > 80 ||
        !Array.isArray(data.permissions) ||
        !data.permissions.includes("read") ||
        data.permissions.length > 3 ||
        !data.permissions.every((p) => ["read", "edit", "comment"].includes(p))
      )
        throw Error("Invalid connection request");
      const page = await api("/api/tools", "POST", {
        operation: "read_page",
        arguments: { page_id: data.page_id },
      });
      if (alive) {
        setRequest(data);
        setTitle(page.content.title);
      }
    })().catch((e) => {
      if (alive) setError(String(e.message));
    });
    return () => {
      alive = false;
    };
  }, []);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main style={{ maxWidth: 640, margin: "48px auto", padding: 24 }}>
      <a href="/">← Pages</a>
      <h1>Agent connections</h1>
      {session === undefined ? (
        <p>Loading…</p>
      ) : !session ? (
        <a
          href={`/api/auth/login?return_to=${encodeURIComponent(location.pathname + location.search)}`}
        >
          Sign in to continue
        </a>
      ) : (
        <>
          {request && !approved && (
            <section>
              <h2>Connect {request.driver}</h2>
              <p>
                This app will act on behalf of {session.display_name || "your account"} on{" "}
                <strong>{title}</strong>.
              </p>
              <p>Permissions: {request.permissions.join(", ")}. Access is limited to this Page.</p>
              <p>
                Approve only a connection you just started in your app or terminal. The app name is
                supplied by that client.
              </p>
              <label>
                Expires in{" "}
                <select value={lifetime} onChange={(e) => setLifetime(Number(e.target.value))}>
                  <option value={3600}>1 hour</option>
                  <option value={28800}>8 hours</option>
                </select>
              </label>
              <p>
                <button
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const value = await api("/api/agent-connections", "POST", {
                        ...request,
                        expires_in: lifetime,
                      });
                      setConnections((previous) => [...previous, value.connection]);
                      setApproved(true);
                    })
                  }
                >
                  Approve connection
                </button>{" "}
                <a href="/?connections=1">Cancel</a>
              </p>
            </section>
          )}
          {approved && <p role="status">Connected. Return to your app or terminal.</p>}
          <h2>Active connections</h2>
          <p>
            Connections keep their approved access until they expire or you revoke them, including
            after sign-out.
          </p>
          {!connections.length && <p>No active connections.</p>}
          {connections.map((connection) => (
            <section key={connection.id}>
              <p>
                <strong>{connection.driver}</strong> · {connection.permissions.join(", ")}
              </p>
              <p>
                <a href={`/?page=${connection.page_id}`}>Open Page</a> · Expires{" "}
                {new Date(connection.expires_at * 1000).toLocaleString()}
              </p>
              <button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await api("/api/agent-connections", "DELETE", { id: connection.id });
                    setConnections((previous) => previous.filter((c) => c.id !== connection.id));
                  })
                }
              >
                Revoke {connection.driver}
              </button>
            </section>
          ))}
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </main>
  );
}
