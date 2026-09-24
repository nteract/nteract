import { createRoot } from "react-dom/client";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { OperatorStore } from "./store.ts";
import {
  bytes,
  cpu,
  currentHost,
  format,
  gapBetween,
  memory,
  timestamp,
  type Metrics,
} from "./metrics.ts";
import "./style.css";

const store = new OperatorStore();

function CpuChart({ data }: { data: Metrics }) {
  const hosts = data.observations.filter((o) => o.kind === "host");
  const points = hosts.map((o, i) => ({ at: o.at, value: cpu(data, hosts[i - 1], o) }));
  if (!points.some((p) => p.value !== null))
    return (
      <p className="empty">
        {data.sourceGapsTruncated
          ? "CPU history has incomplete gap detail. Try a shorter range."
          : "No measured CPU usage in this range."}
      </p>
    );
  const start = points[0].at,
    end = Math.max(start + 60_000, points.at(-1)!.at);
  const x = (at: number) => 40 + ((at - start) / (end - start)) * 820;
  const y = (value: number) => 175 - value * 1.5;
  let path = "",
    previous: number | null = null;
  for (const p of points) {
    if (p.value === null) {
      previous = null;
      continue;
    }
    path += `${data.sourceGapsTruncated || previous === null || gapBetween(data, previous, p.at, "host") ? "M" : "L"}${x(p.at)},${y(p.value)} `;
    previous = p.at;
  }
  return (
    <>
      <svg
        className="chart"
        viewBox="0 0 900 220"
        role="img"
        aria-label="Host CPU busy percentage over time; missing samples are gaps"
      >
        {[0, 25, 50, 75, 100].map((v) => (
          <g key={v}>
            <line x1="40" x2="860" y1={y(v)} y2={y(v)} />
            <text x="32" y={y(v) + 4} textAnchor="end">
              {v}%
            </text>
          </g>
        ))}
        <path d={path} className="cpu-line" />
        {points
          .filter((p) => p.value !== null)
          .map((p) => (
            <circle key={p.at} cx={x(p.at)} cy={y(p.value!)} r="2">
              <title>
                {timestamp(p.at)} · CPU {format(p.value, "%")}
              </title>
            </circle>
          ))}
        {[0, 1, 2].map((i) => (
          <text
            key={i}
            x={x(start + ((end - start) * i) / 2)}
            y="205"
            textAnchor={i === 0 ? "start" : i === 2 ? "end" : "middle"}
          >
            {new Date(start + ((end - start) * i) / 2).toLocaleString([], {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </text>
        ))}
      </svg>
      <p className="caption">
        CPU rates between sampled counters. Chart snapshots every {format(data.strideMs / 60_000)}{" "}
        minute(s); brief peaks can be missed. Gaps remain visible.
      </p>
    </>
  );
}

function Fleet({ data }: { data: Metrics }) {
  const current = data.observations.filter((o) => o.at === data.latest?.at);
  const known = !data.stale && data.latest?.discovery_status === "ok";
  return (
    <section>
      <div className="section-heading">
        <h2>Fleet inventory</h2>
        <span className="muted">{data.previews.length} retained endpoints</span>
      </div>
      <p className="caption">
        Deployment status is the last registry observation. Each application, output and renderer
        service is a separate celld fleet. Measurements below come from the latest collection.
      </p>
      {!known && (
        <p className="notice">
          Current fleet state is unknown. Retained deployment records are shown for reference.
        </p>
      )}
      {data.previews.length ? (
        <div className="fleet-grid">
          {data.previews.map((preview) => (
            <article key={preview.id} className="fleet-card">
              <div className="section-heading">
                <h3>{preview.id}</h3>
                <Badge variant="outline">
                  {known ? preview.status : `Last: ${preview.status}`}
                </Badge>
              </div>
              <p className="revision">Revision {preview.revision?.slice(0, 12) ?? "unknown"}</p>
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
                const s = known && service?.status === "ok" ? service.values : {};
                const f = known && fleet?.status === "ok" ? fleet.values : {};
                return (
                  <div className="fleet-role" key={role}>
                    <div>
                      <strong>{role}</strong>
                      <small>{known ? (service?.status ?? "unmeasured") : "unknown"}</small>
                    </div>
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
                    </dl>
                    {f.pressured === 1 && <p className="notice">Memory pressure reported</p>}
                    {(f.capacity_waiting ?? 0) > 0 && (
                      <p className="notice">{format(f.capacity_waiting)} waiting for capacity</p>
                    )}
                  </div>
                );
              })}
            </article>
          ))}
        </div>
      ) : (
        <p className="empty">No deployment inventory has been collected.</p>
      )}
    </section>
  );
}

function Dashboard({ data, hours }: { data: Metrics; hours: number }) {
  const host = currentHost(data);
  const busy = host ? cpu(data, data.currentHost.at(-2), host, true) : null;
  return (
    <>
      <div className="notice" role="status">
        <strong>{data.stale ? "Measurements stale or absent" : "Latest collection"}</strong> ·{" "}
        {data.latest ? timestamp(data.latest.at) : "No samples yet"}
        <br />
        {data.provenance} · Collected and refreshed every 60 seconds.
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
      <section>
        <div className="section-heading">
          <h2>CPU history</h2>
          <span className="muted">
            Last {hours >= 24 ? `${hours / 24} day(s)` : `${hours} hours`}
          </span>
        </div>
        <CpuChart data={data} />
      </section>
      <Fleet data={data} />
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
                      {event.preview} · {event.status}
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
              <dd>{data.gaps.length}</dd>
            </div>
            <div>
              <dt>Retention</dt>
              <dd>{data.retentionDays} days</dd>
            </div>
          </dl>
          {data.sourceGapsTruncated && (
            <p className="notice">
              Gap detail is incomplete. Only adjacent CPU samples are shown, with disconnected chart
              lines.
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
