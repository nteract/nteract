import { createRoot } from "react-dom/client";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { OperatorStore } from "./store.ts";
import { bytes, cpu, currentHost, format, memory, timestamp, type Metrics } from "./metrics.ts";
import { HistoryCharts } from "./charts.tsx";
import { endpointName, fleetGroups, fleetKnown, historyCoverage, measured } from "./projections.ts";
import "./style.css";

const store = new OperatorStore();

function Fleet({ data }: { data: Metrics }) {
  const current = data.observations.filter((o) => o.at === data.latest?.at);
  const groups = fleetGroups(data);
  return (
    <section>
      <div className="section-heading">
        <h2>Current deployments</h2>
        <span className="muted">
          {groups.current.length} {groups.known ? "monitored" : "last observed"}
        </span>
      </div>
      <p className="caption">
        Each application, output and renderer service is a separate celld fleet. Values come from
        the latest collection; an unavailable measurement stays unknown.
      </p>
      {!groups.known && (
        <p className="notice">
          {data.stale
            ? "Current fleet state is unknown. Last observed deployments are shown for reference."
            : "Managed preview discovery is unavailable. Their last observed state is shown for reference; original app measurements are independent."}
        </p>
      )}
      {!data.previews.some((p) => p.id === "app") && (
        <p className="caption">
          This collector currently covers managed main and PR deployments. The original app.runt.run
          fleet is not included.
        </p>
      )}
      {groups.current.length ? (
        <div className="fleet-grid">
          {groups.current.map((preview) => (
            <article key={preview.id} className="fleet-card">
              <div className="section-heading">
                <h3>{endpointName(preview.id)}</h3>
                <Badge variant="outline">
                  {fleetKnown(data, preview.id) ? preview.status : `Last: ${preview.status}`}
                </Badge>
              </div>
              <p className="revision">
                {preview.id === "app"
                  ? "Observed outside the preview lifecycle"
                  : `Revision ${preview.revision?.slice(0, 12) ?? "unknown"}`}
              </p>
              {preview.desiredRevision && preview.desiredRevision !== preview.revision && (
                <p className="caption">Requested {preview.desiredRevision.slice(0, 12)}</p>
              )}
              {["main", "outputs", "renderer-assets"].map((role) => {
                const service = current.find(
                  (o) => o.kind === "service" && o.preview === preview.id && o.role === role,
                );
                const fleet = current.find(
                  (o) => o.kind === "fleet" && o.preview === preview.id && o.role === role,
                );
                const known = fleetKnown(data, preview.id);
                const s = known && measured(service) ? service!.values : {};
                const f = known && measured(fleet) ? fleet!.values : {};
                return (
                  <div className="fleet-role" key={role}>
                    <div>
                      <strong>{role}</strong>
                      <small>{known ? (service?.status ?? "unmeasured") : "unknown"}</small>
                    </div>
                    {known && fleet?.status !== "ok" && (
                      <p className="caption">Fleet census: {fleet?.status ?? "unmeasured"}</p>
                    )}
                    <dl>
                      <div>
                        <dt>Memory</dt>
                        <dd>{bytes(s.memory_bytes)}</dd>
                      </div>
                      <div>
                        <dt>Resident objects</dt>
                        <dd>{format(f.resident_objects)}</dd>
                      </div>
                      <div>
                        <dt>WebSockets</dt>
                        <dd>{format(f.websockets)}</dd>
                      </div>
                      <div>
                        <dt>Restarts / OOM</dt>
                        <dd>
                          {format(s.automatic_restarts)} / {format(s.oom_kills)}
                        </dd>
                      </div>
                      <div>
                        <dt>Waiting: activation / capacity</dt>
                        <dd>
                          {format(f.activation_waiting)} / {format(f.capacity_waiting)}
                        </dd>
                      </div>
                      <div>
                        <dt>Pressure</dt>
                        <dd>{f.pressured === 0 ? "No" : f.pressured === 1 ? "Yes" : "—"}</dd>
                      </div>
                    </dl>
                  </div>
                );
              })}
            </article>
          ))}
        </div>
      ) : (
        <p className="empty">No current deployments were observed.</p>
      )}
      {groups.retained.length > 0 && (
        <details className="retained">
          <summary>{groups.retained.length} stopped previews · saved state retained</summary>
          <p className="caption">
            These previews are stopped, so there are no current fleet measurements. Their saved
            state and deployment history remain available.
          </p>
          <ul className="retained-list">
            {groups.retained.map((p) => (
              <li key={p.id}>
                <strong>{p.id}</strong>
                <span>Revision {p.revision?.slice(0, 12) ?? "unknown"}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function Dashboard({ data, hours }: { data: Metrics; hours: number }) {
  const host = currentHost(data);
  const coverage = historyCoverage(data);
  const busy = host ? cpu(data, data.currentHost.at(-2), host, true) : null;
  return (
    <>
      <div className="notice" role="status">
        <strong>{data.stale ? "Measurements stale or absent" : "Latest collection"}</strong> ·{" "}
        {data.latest ? timestamp(data.latest.at) : "No samples yet"}
        <br />
        {data.provenance} · Collected and refreshed every 60 seconds.
        {coverage.first !== null && (
          <>
            <br />
            Available history begins {timestamp(coverage.first)}.
            {data.coverage!.requestedFrom < coverage.first &&
              " Earlier selected time has no retained measurements."}
          </>
        )}
      </div>
      <div className="gauges">
        {[
          ["Host CPU", format(busy, "%"), "Across all host CPUs"],
          ["Memory used", format(memory(host), "%"), "Host memory"],
          ["Disk available", bytes(host?.values.disk_available_bytes), "Host filesystem"],
          ["celld CLI", data.runtime?.version ?? "Unknown", "Recorded installed version"],
        ].map(([label, value, detail]) => (
          <div className="gauge" key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
            <small>{detail}</small>
          </div>
        ))}
      </div>
      <HistoryCharts data={data} hours={hours} />
      <Fleet data={data} />
      {data.processChanges && (
        <section>
          <h2>Service process changes</h2>
          <p className="caption">
            Observed process replacements include manual starts. Times mark collection, not the
            exact restart.
            {data.processChanges.length > 10 &&
              ` Showing the latest 10 of ${data.processChanges.length} returned observations; the JSON export includes the full returned history.`}
          </p>
          {data.processChanges.length ? (
            <ul className="events">
              {data.processChanges.slice(0, 10).map((event, i) => (
                <li key={i}>
                  {endpointName(event.preview) || "Infrastructure"} · {event.role}
                  <small>{timestamp(event.at)}</small>
                </li>
              ))}
            </ul>
          ) : (
            <p className="caption">No process replacements observed in this range.</p>
          )}
          {data.processChangesTruncated && (
            <p className="notice">Process-change history is incomplete. Choose a shorter range.</p>
          )}
        </section>
      )}
      <div className="details-grid">
        <section>
          <h2>Deployment history</h2>
          <p className="caption">Retained observations in the selected time range.</p>
          {data.deployments.length ? (
            <ol className="events">
              {data.deployments
                .slice(-30)
                .reverse()
                .map((event, i) => (
                  <li key={`${event.at}-${i}`}>
                    <span>
                      {endpointName(event.preview)} · {event.status}
                    </span>
                    <small>
                      {timestamp(event.at)} · {event.revision?.slice(0, 12) ?? "revision unknown"}
                    </small>
                  </li>
                ))}
            </ol>
          ) : (
            <p className="empty">No deployment changes recorded in this range.</p>
          )}
        </section>
        <section>
          <h2>Collection health</h2>
          <dl className="health">
            <div>
              <dt>Discovery</dt>
              <dd>{data.latest?.discovery_status ?? "unknown"}</dd>
            </div>
            <div>
              <dt>Journal</dt>
              <dd>{data.latest?.journal_status ?? "unknown"}</dd>
            </div>
            <div>
              <dt>Collection duration</dt>
              <dd>{format(data.latest ? data.latest.duration_ms / 1000 : null, " s")}</dd>
            </div>
            <div>
              <dt>Collection gaps</dt>
              <dd>{coverage.gaps}</dd>
            </div>
            <div>
              <dt>Retention</dt>
              <dd>{data.retentionDays} days</dd>
            </div>
          </dl>
          {data.sourceGapsTruncated && (
            <p className="notice">
              Gap detail is incomplete. Chart points are shown without connecting lines.
            </p>
          )}
          {data.latest?.recovery && <p className="notice">Journal recovery recorded</p>}
          <div className="exports">
            <Button variant="outline" asChild>
              <a href={`/api/operator/export.json?hours=${hours}`}>Export JSON</a>
            </Button>
            <Button variant="outline" asChild>
              <a href={`/api/operator/export.csv?hours=${hours}`}>Export CSV</a>
            </Button>
          </div>
        </section>
      </div>
    </>
  );
}

function App() {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [hours, setHours] = useState(24);
  useEffect(() => store.start(), []);
  useEffect(() => {
    const visible = () => {
      if (document.visibilityState === "visible") void store.refresh();
    };
    document.addEventListener("visibilitychange", visible);
    return () => document.removeEventListener("visibilitychange", visible);
  }, []);
  return (
    <main>
      <header>
        <div>
          <p className="eyebrow">nteract / operations</p>
          <h1>Deployment overview</h1>
          <p className="muted">Fleet inventory and operational history</p>
        </div>
        <Badge variant="outline">Read only</Badge>
      </header>
      <div className="toolbar">
        <label>
          History{" "}
          <select
            value={hours}
            onChange={(e) => {
              const h = Number(e.target.value);
              setHours(h);
              store.setHours(h);
            }}
          >
            <option value="1">1 hour</option>
            <option value="6">6 hours</option>
            <option value="24">24 hours</option>
            <option value="168">7 days</option>
            <option value="336">14 days</option>
          </select>
        </label>
        <Button
          variant="outline"
          disabled={
            state.refreshing || ["signing-out", "signed-out", "denied"].includes(state.phase)
          }
          onClick={() => void store.refresh()}
        >
          {state.refreshing ? "Refreshing…" : "Refresh"}
        </Button>
        {(state.data || state.phase === "denied" || state.phase === "error") && (
          <Button variant="ghost" onClick={() => void store.signOut()}>
            Sign out
          </Button>
        )}
      </div>
      {state.phase === "loading" && (
        <p className="empty" role="status">
          Checking your session…
        </p>
      )}
      {state.phase === "signing-out" && (
        <p className="empty" role="status">
          Signing out…
        </p>
      )}
      {(state.phase === "signed-out" || state.phase === "denied") && (
        <section className="login">
          <h2>
            {state.phase === "denied"
              ? "This account cannot view operations"
              : "Sign in to view operations"}
          </h2>
          <p>Access is limited to the operator email safelist.</p>
          <Button asChild>
            <a href="/api/auth/oidc/login">Sign in</a>
          </Button>
        </section>
      )}
      {state.message && (
        <p className="notice" role="alert">
          {state.message}
        </p>
      )}
      {state.data && <Dashboard data={state.data} hours={state.dataHours} />}
      <footer>nteract on celld · Read-only measurements · No model calls</footer>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
