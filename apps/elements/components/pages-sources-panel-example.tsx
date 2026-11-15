"use client";

import { useEffect, useId, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ChartNoAxesCombined,
  Check,
  ChevronRight,
  Code2,
  Database,
  FileCode2,
  GitBranch,
  History,
  Maximize2,
  Minimize2,
  PanelRight,
  Pin,
  Search,
  Table2,
  TriangleAlert,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import styles from "./pages-sources-panel-example.module.css";

// Deterministic design data only. These nodes are a visual vocabulary, not
// a proposed persisted schema or a replacement execution/dependency graph.
type Kind = "source" | "calculation" | "result" | "view";
type Item = {
  id: string;
  name: string;
  kind: Kind;
  detail: string;
  x: number;
  y: number;
  pinned?: boolean;
  unused?: boolean;
};
type Edge = { from: string; to: string; label: string; pinned?: boolean };
type Scenario = "current" | "future" | "empty" | "missing";
const current: Item[] = [
  { id: "usage", name: "Usage", kind: "source", detail: "Parquet · version 7", x: 64, y: 70 },
  { id: "targets", name: "Targets", kind: "source", detail: "Parquet · version 2", x: 64, y: 310 },
  {
    id: "rates",
    name: "Exchange rates",
    kind: "source",
    detail: "Not used on this Page",
    x: 64,
    y: 430,
    unused: true,
  },
  { id: "activity", name: "Tool activity", kind: "view", detail: "Vega-Lite chart", x: 650, y: 30 },
  { id: "table", name: "Usage table", kind: "view", detail: "Sift table", x: 650, y: 150 },
  {
    id: "snapshot",
    name: "Quarterly snapshot",
    kind: "view",
    detail: "Sift table · pinned to v5",
    x: 650,
    y: 270,
    pinned: true,
  },
  { id: "budget", name: "Team targets", kind: "view", detail: "Vega-Lite chart", x: 650, y: 390 },
];
const currentEdges: Edge[] = [
  { from: "usage", to: "activity", label: "follows" },
  { from: "usage", to: "table", label: "follows" },
  { from: "usage", to: "snapshot", label: "pinned · v5", pinned: true },
  { from: "targets", to: "budget", label: "follows" },
];
const future: Item[] = [
  { id: "usage", name: "Usage", kind: "source", detail: "Parquet · version 7", x: 20, y: 120 },
  { id: "targets", name: "Targets", kind: "source", detail: "Parquet · version 2", x: 20, y: 340 },
  {
    id: "weekly",
    name: "Summarize by team",
    kind: "calculation",
    detail: "SQL calculation",
    x: 270,
    y: 120,
  },
  {
    id: "summary",
    name: "Weekly usage",
    kind: "result",
    detail: "Computed result · 24 rows",
    x: 520,
    y: 120,
  },
  {
    id: "activity",
    name: "Team activity",
    kind: "view",
    detail: "Custom view · JavaScript",
    x: 770,
    y: 60,
  },
  {
    id: "budget",
    name: "Usage vs. targets",
    kind: "view",
    detail: "Vega-Lite chart",
    x: 770,
    y: 340,
  },
];
const futureEdges: Edge[] = [
  { from: "usage", to: "weekly", label: "input" },
  { from: "weekly", to: "summary", label: "produces" },
  { from: "summary", to: "activity", label: "reads" },
  { from: "summary", to: "budget", label: "reads" },
  { from: "targets", to: "budget", label: "reads" },
];
const labels: Record<Kind, string> = {
  source: "Source",
  calculation: "Calculation",
  result: "Result",
  view: "View",
};
function ItemIcon({ item, size = 16 }: { item: Item; size?: number }) {
  const Icon =
    item.kind === "source" || item.kind === "result"
      ? Database
      : item.kind === "calculation"
        ? FileCode2
        : item.id === "table" || item.id === "snapshot"
          ? Table2
          : item.detail.includes("JavaScript")
            ? Code2
            : ChartNoAxesCombined;
  return <Icon size={size} aria-hidden="true" />;
}

function Connections({
  items,
  edges,
  selected,
  onSelect,
  focused,
  missing,
  changed,
}: {
  items: Item[];
  edges: Edge[];
  selected: string;
  onSelect: (id: string) => void;
  focused: boolean;
  missing: boolean;
  changed: boolean;
}) {
  const arrowId = useId().replace(/:/g, "");
  const related = new Set([selected]);
  // The focus view includes the whole upstream/downstream lineage, including
  // paths through intermediates; it never invents a connection from position.
  for (const direction of ["up", "down"]) {
    const visited = new Set([selected]);
    for (let i = 0; i < items.length; i++)
      for (const edge of edges) {
        const start = direction === "up" ? edge.to : edge.from;
        const end = direction === "up" ? edge.from : edge.to;
        if (visited.has(start)) {
          visited.add(end);
          related.add(end);
        }
      }
  }
  return (
    <div
      className={styles.mapScroll}
      tabIndex={0}
      aria-label="Connection map. Scroll horizontally on small screens; select a node to inspect it."
    >
      <div className={styles.map}>
        <svg width="1000" height="550" aria-hidden="true">
          <defs>
            <marker
              id={arrowId}
              markerUnits="userSpaceOnUse"
              markerWidth="8"
              markerHeight="8"
              refX="7"
              refY="4"
              orient="auto"
            >
              <path d="M0 0 L8 4 L0 8" fill="var(--muted)" />
            </marker>
          </defs>
          {edges.map((edge) => {
            const from = items.find((item) => item.id === edge.from)!;
            const to = items.find((item) => item.id === edge.to)!;
            const active = related.has(edge.from) && related.has(edge.to);
            const x = from.x + 200,
              y = from.y + 42,
              endX = to.x,
              endY = to.y + 42;
            const mid = (x + endX) / 2;
            return (
              <g
                key={`${edge.from}-${edge.to}`}
                opacity={focused && !active ? 0.12 : 1}
                className={active ? styles.activeEdge : styles.edge}
              >
                <path
                  d={`M${x},${y} C${mid},${y} ${mid},${endY} ${endX - 7},${endY}`}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={active ? 1.8 : 1.3}
                  strokeDasharray={edge.pinned ? "5 5" : undefined}
                  markerEnd={`url(#${arrowId})`}
                />
                {endX - x > 200 && (
                  <text x={mid} y={(y + endY) / 2 - 9} textAnchor="middle">
                    {edge.label}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            className={styles.graphNode}
            style={{
              left: item.x,
              top: item.y,
              opacity: focused && !related.has(item.id) ? 0.28 : 1,
            }}
            data-kind={item.kind}
            aria-pressed={selected === item.id}
            onClick={() => onSelect(item.id)}
          >
            <span className={styles.nodeType}>
              <ItemIcon item={item} />
              {labels[item.kind]}
              {item.pinned && <Pin size={12} />}
            </span>
            <strong>{item.name}</strong>
            <small>
              {missing && item.id === "usage"
                ? "Source removed"
                : changed && item.id === "usage"
                  ? "Parquet · version 8"
                  : item.detail}
            </small>
          </button>
        ))}
      </div>
    </div>
  );
}

function PagePreview({
  open,
  selected,
  onOpen,
  missing,
  changed,
}: {
  open: boolean;
  selected: string;
  onOpen: (id: string) => void;
  missing: boolean;
  changed: boolean;
}) {
  return (
    <article className={styles.document}>
      <span className={styles.eyebrow}>Workspace / Reports</span>
      <h2>Workspace usage</h2>
      <div className={styles.sourceLineGroup}>
        {!missing ? (
          <button
            className={styles.sourceLine}
            aria-expanded={open}
            onClick={() => onOpen("usage")}
          >
            <Database size={13} aria-hidden="true" />3 sources · newest{" "}
            {changed ? "just now" : "2 hours ago"} · oldest Nov 2
          </button>
        ) : (
          [
            ["rates", "Exchange rates", "added Nov 2"],
            ["targets", "Targets", "added Nov 2"],
            ...(!missing
              ? [["usage", "Usage", changed ? "refreshed just now" : "refreshed 2 hours ago"]]
              : []),
          ].map(([id, name, time]) => (
            <button
              key={id}
              className={styles.sourceLine}
              aria-expanded={open}
              onClick={() => onOpen(id)}
            >
              <Database size={13} />
              {name} · {time}
            </button>
          ))
        )}
      </div>
      <p>A closer look at how the team uses tools, and where that work happens.</p>
      <section className={styles.pageFigure} data-selected={open && selected === "activity"}>
        <div className={styles.figureHeading}>
          <h3>Tool activity</h3>
          {open && (
            <button onClick={() => onOpen("usage")} className={styles.binding}>
              <Database size={12} /> Usage · follows
            </button>
          )}
        </div>
        {missing ? (
          <p className={styles.missing}>
            <TriangleAlert size={16} />
            Source “Usage” is unavailable.
          </p>
        ) : (
          <div className={styles.chart} aria-label="Illustrative bar chart">
            <div>
              {[42, 72, 58, 90, 64, 82, 96].map((value, i) => (
                <span
                  key={i}
                  style={{ height: `${changed ? Math.min(100, value + 6) : value}%` }}
                />
              ))}
            </div>
            <footer>
              <span>Mon</span>
              <span>Tue</span>
              <span>Wed</span>
              <span>Thu</span>
              <span>Fri</span>
              <span>Sat</span>
              <span>Sun</span>
            </footer>
          </div>
        )}
      </section>
      <section className={styles.pageFigure} data-selected={open && selected === "table"}>
        <div className={styles.figureHeading}>
          <h3>The data</h3>
          {open && (
            <button onClick={() => onOpen("usage")} className={styles.binding}>
              <Database size={12} /> Usage · follows
            </button>
          )}
        </div>
        {missing ? (
          <p className={styles.missing}>Source “Usage” is unavailable.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Team</th>
                <th>Tool calls</th>
                <th>Active days</th>
              </tr>
            </thead>
            <tbody>
              {[
                ["Platform", changed ? "8,600" : "8,420", "7"],
                ["Research", "6,180", "7"],
                ["Product", "3,820", "6"],
              ].map((row) => (
                <tr key={row[0]}>
                  {row.map((value) => (
                    <td key={value}>{value}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </article>
  );
}

export function PagesSourcesPanelExample({ embedded = false }: { embedded?: boolean }) {
  const [scenario, setScenario] = useState<Scenario>("current");
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const sourcesButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (open) {
      openerRef.current = document.activeElement as HTMLElement;
      panelRef.current?.focus();
    } else if (openerRef.current) {
      const opener = openerRef.current;
      if (opener.isConnected) opener.focus();
      else sourcesButtonRef.current?.focus();
      openerRef.current = null;
    }
  }, [open]);
  function closePanel() {
    setOpen(false);
  }
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState("usage");
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<"connections" | "versions" | "preview">("connections");
  const [focused, setFocused] = useState(false);
  const [replacement, setReplacement] = useState(false);
  const [changed, setChanged] = useState(false);
  const [dark, setDark] = useState(false);
  const items = scenario === "empty" ? [] : scenario === "future" ? future : current;
  const edges = scenario === "future" ? futureEdges : currentEdges;
  const item = items.find((node) => node.id === selected) ?? items[0];
  const sourceItems = items.filter((node) => node.kind === "source");
  const incoming = edges.filter((edge) => edge.to === item?.id);
  const outgoing = edges.filter((edge) => edge.from === item?.id);
  const missing = scenario === "missing";
  const version = item?.id === "usage" ? (changed ? 8 : 7) : item?.id === "targets" ? 2 : 1;
  const versions =
    item?.id === "usage" ? (changed ? [8, 7, 6, 5] : [7, 6, 5]) : version === 2 ? [2, 1] : [1];
  const previewRows =
    item?.id === "targets"
      ? [
          ["Platform", "9,000"],
          ["Research", "7,000"],
          ["Product", "4,000"],
        ]
      : item?.id === "rates"
        ? [
            ["USD", "1.00"],
            ["EUR", "0.92"],
            ["GBP", "0.78"],
          ]
        : [
            ["Platform", changed ? "8,600" : "8,420"],
            ["Research", "6,180"],
            ["Product", "3,820"],
          ];
  function select(id: string) {
    setSelected(id);
    setTab("connections");
    setReplacement(false);
  }
  function chooseScenario(value: Scenario) {
    setScenario(value);
    select("usage");
    setQuery("");
    setChanged(false);
    setFocused(false);
    setOpen(value !== "current");
    setExpanded(value === "future");
  }
  const Root = embedded ? "div" : "main";
  return (
    <Root className={styles.study} data-theme={dark ? "dark" : "light"}>
      <header className={styles.studyHeader}>
        <div>
          <span className={styles.eyebrow}>PAGES · DESIGN STUDY</span>
          <h1>Follow the data.</h1>
          <p>Inspect a source beside the document. Open the map when you need the whole picture.</p>
        </div>
        <label>
          <input
            type="checkbox"
            checked={dark}
            onChange={(event) => setDark(event.target.checked)}
          />{" "}
          Dark
        </label>
      </header>
      <div className={styles.studyControls} aria-label="Design scenarios">
        {(
          [
            ["current", "Sources today"],
            ["future", "Future pipeline"],
            ["empty", "No sources"],
            ["missing", "Missing source"],
          ] as const
        ).map(([value, title]) => (
          <Button
            key={value}
            variant={scenario === value ? "secondary" : "outline"}
            aria-pressed={scenario === value}
            onClick={() => chooseScenario(value)}
          >
            {title}
          </Button>
        ))}
        <span>Interactive mockup · sample data · changes reset on reload</span>
      </div>
      {scenario === "future" && (
        <p className={styles.concept}>
          Future concept: calculations, intermediate results, and custom renderers. Execution and
          storage choices are still open.
        </p>
      )}
      <div className={styles.app} data-expanded={expanded && open} data-panel={open}>
        <header className={styles.appBar}>
          <strong>
            Pages <ChevronRight size={13} />
            <span>Workspace usage</span>
          </strong>
          <button
            ref={sourcesButtonRef}
            aria-expanded={open}
            onClick={() => (open ? closePanel() : setOpen(true))}
          >
            <PanelRight size={16} /> Sources
          </button>
        </header>
        {!expanded || !open ? (
          scenario === "empty" ? (
            <article className={styles.document}>
              <span className={styles.eyebrow}>Workspace / Notes</span>
              <h2>Project notes</h2>
              <p>A document with no data attached. The title has its usual spacing.</p>
            </article>
          ) : (
            <PagePreview
              open={open}
              selected={selected}
              missing={missing}
              changed={changed}
              onOpen={(id) => {
                setOpen(true);
                select(id);
              }}
            />
          )
        ) : (
          <section className={styles.mapWorkspace} aria-label="Source connections">
            <div className={styles.mapHeading}>
              <div>
                <span className={styles.eyebrow}>WORKSPACE USAGE</span>
                <h2>How the data connects</h2>
                <p>
                  {scenario === "future"
                    ? "Sources → calculations → results → views"
                    : "Sources → tables and charts on this Page"}
                </p>
              </div>
              <button
                className={styles.plainButton}
                aria-pressed={focused}
                onClick={() => setFocused(!focused)}
              >
                <GitBranch size={15} />
                {focused ? "Show everything" : "Focus selection"}
              </button>
            </div>
            <Connections
              items={items}
              edges={edges}
              selected={selected}
              onSelect={select}
              focused={focused}
              missing={missing}
              changed={changed}
            />
            <div className={styles.legend}>
              <span>
                <i /> Reads latest
              </span>
              <span>
                <i data-dashed /> Pinned version
              </span>
              <span>Choose a node to inspect its inputs and uses.</span>
            </div>
          </section>
        )}
        {open && (
          <aside
            ref={panelRef}
            tabIndex={-1}
            className={styles.panel}
            aria-label="Sources panel"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                closePanel();
              }
            }}
          >
            <header className={styles.panelHeader}>
              <h2>{expanded ? "Inspector" : "Sources"}</h2>
              <div>
                <button
                  aria-label={expanded ? "Return to Page" : "Expand connection map"}
                  onClick={() => setExpanded(!expanded)}
                >
                  {expanded ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
                </button>
                <button aria-label="Close sources panel" onClick={closePanel}>
                  <X size={18} />
                </button>
              </div>
            </header>
            {items.length === 0 ? (
              <div className={styles.empty}>
                <Database size={28} />
                <h3>No sources yet</h3>
                <p>
                  Sources added to this Page will appear here, along with the tables and charts that
                  use them.
                </p>
                <p className={styles.muted}>
                  Your agent can add a named source. Upload controls can come later.
                </p>
              </div>
            ) : (
              <>
                {!expanded && (
                  <div className={styles.inventory}>
                    <label className={styles.search}>
                      <Search size={14} />
                      <input
                        aria-label="Find a source"
                        placeholder="Find a source…"
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                      />
                    </label>
                    {sourceItems
                      .filter((node) => node.name.toLowerCase().includes(query.toLowerCase()))
                      .map((node) => (
                        <button
                          key={node.id}
                          className={styles.sourceRow}
                          aria-pressed={item?.id === node.id}
                          onClick={() => select(node.id)}
                        >
                          <Database size={16} />
                          <span>
                            <strong>{node.name}</strong>
                            <small>
                              {missing && node.id === "usage"
                                ? "Missing · 3 affected uses"
                                : node.unused
                                  ? "Not used on this Page"
                                  : `${edges.filter((edge) => edge.from === node.id).length} uses · ${node.id === "usage" ? (changed ? "refreshed just now" : "refreshed 2 hours ago") : "added Nov 2"}`}
                            </small>
                          </span>
                          <ChevronRight size={14} />
                        </button>
                      ))}
                    {sourceItems.every(
                      (node) => !node.name.toLowerCase().includes(query.toLowerCase()),
                    ) && <p className={styles.muted}>No matching sources.</p>}
                    <button className={styles.mapLink} onClick={() => setExpanded(true)}>
                      <GitBranch size={15} /> See all connections <ArrowRight size={14} />
                    </button>
                  </div>
                )}
                {item && (
                  <div className={styles.inspector}>
                    <span className={styles.nodeType}>
                      <ItemIcon item={item} />
                      {labels[item.kind]}
                      {scenario === "future" && item.kind !== "source" && (
                        <span className={styles.proposed}>Concept</span>
                      )}
                    </span>
                    <h3>{item.name}</h3>
                    <p className={styles.description}>
                      {item.kind === "source" ? `Parquet · version ${version}` : item.detail}
                    </p>
                    {missing && item.id === "usage" ? (
                      <p className={styles.notice}>
                        <TriangleAlert size={16} /> This source was removed. Its 3 uses draw empty
                        until their bindings are repaired.
                      </p>
                    ) : item.kind === "source" ? (
                      <dl className={styles.facts}>
                        <div>
                          <dt>{item.id === "usage" ? "Refreshed" : "Added"}</dt>
                          <dd>
                            {changed && item.id === "usage"
                              ? "Just now · version 8"
                              : item.id === "usage"
                                ? "Today, 9:00 AM · v7"
                                : `Nov 2 · version ${version}`}
                          </dd>
                        </div>
                        <div>
                          <dt>Set by</dt>
                          <dd>
                            Kyle Kelley <span>via Daily refresh*</span>
                          </dd>
                        </div>
                        <div>
                          <dt>Dataset</dt>
                          <dd>
                            {item.id === "usage" ? "18,420 rows · 1.8 MB" : "24 rows · 4.2 KB"}
                          </dd>
                        </div>
                      </dl>
                    ) : (
                      <p className={styles.muted}>
                        {item.kind === "calculation"
                          ? "Groups tool calls by team and week."
                          : item.kind === "result"
                            ? "An intermediate you can inspect and reuse. No block on the Page is required."
                            : item.detail.includes("JavaScript")
                              ? "Custom code draws this view in an isolated frame. The renderer is a property of the view."
                              : "This view appears in the Page. Its data binding is separate from its presentation."}
                      </p>
                    )}
                    <div className={styles.tabs} aria-label="Inspector sections">
                      {(
                        [
                          ["connections", "Connections"],
                          ["preview", item.kind === "calculation" ? "Query" : "Preview"],
                          ...(item.kind === "source" && !missing ? [["versions", "Versions"]] : []),
                        ] as [typeof tab, string][]
                      ).map(([value, title]) => (
                        <button
                          key={value}
                          aria-pressed={tab === value}
                          onClick={() => setTab(value)}
                        >
                          {title}
                        </button>
                      ))}
                    </div>
                    {tab === "connections" && (
                      <>
                        {incoming.length > 0 && (
                          <>
                            <h4>Reads from</h4>
                            {incoming.map((edge) => {
                              const upstream = items.find((node) => node.id === edge.from)!;
                              return (
                                <button
                                  key={edge.from}
                                  className={styles.connectionRow}
                                  onClick={() => select(edge.from)}
                                >
                                  <ItemIcon item={upstream} />
                                  <span>
                                    <strong>{upstream.name}</strong>
                                    <small>
                                      {edge.pinned ? "Pinned to version 5" : "Follows latest"}
                                    </small>
                                  </span>
                                  <ArrowLeft size={14} />
                                </button>
                              );
                            })}
                          </>
                        )}
                        <h4>
                          {item.kind === "view" ? "On this Page" : `Used by · ${outgoing.length}`}
                        </h4>
                        {outgoing.map((edge) => {
                          const consumer = items.find((node) => node.id === edge.to)!;
                          return (
                            <button
                              key={edge.to}
                              className={styles.connectionRow}
                              onClick={() => select(edge.to)}
                            >
                              <ItemIcon item={consumer} />
                              <span>
                                <strong>{consumer.name}</strong>
                                <small>
                                  {edge.pinned ? "Pinned · version 5" : "Follows latest"}
                                </small>
                              </span>
                              {edge.pinned ? <Pin size={13} /> : <ChevronRight size={14} />}
                            </button>
                          );
                        })}
                        {item.unused && (
                          <p className={styles.muted}>
                            Nothing on this Page reads this source. It is still available to use.
                          </p>
                        )}
                        {item.kind === "view" && (
                          <p className={styles.muted}>
                            {item.id === "activity" || item.id === "table"
                              ? "Highlighted in the document while this panel is open."
                              : "A placed view can be located in the document from here."}
                          </p>
                        )}
                      </>
                    )}
                    {tab === "versions" && (
                      <ol className={styles.versions}>
                        {versions.map((version, index) => (
                          <li key={version}>
                            <History size={14} />
                            <div>
                              <strong>
                                Version {version} {index === 0 && <span>· current</span>}
                              </strong>
                              <small>
                                {index === 0
                                  ? changed && item.id === "usage"
                                    ? "Just now"
                                    : item.id === "usage"
                                      ? "Today, 9:00 AM"
                                      : "Nov 2, 9:00 AM"
                                  : index === 1
                                    ? "Nov 13, 9:00 AM"
                                    : "Nov 12, 9:00 AM"}
                              </small>
                              {version === 5 && (
                                <small>
                                  <Pin size={11} /> Quarterly snapshot stays here
                                </small>
                              )}
                            </div>
                          </li>
                        ))}
                      </ol>
                    )}
                    {tab === "preview" &&
                      (item.kind === "calculation" ? (
                        <pre className={styles.code}>
                          {
                            "SELECT team, week,\n  count(*) AS calls\nFROM usage\nGROUP BY team, week"
                          }
                        </pre>
                      ) : (
                        <div className={styles.dataPreview}>
                          <p>Sample · first 3 rows</p>
                          <table>
                            <thead>
                              <tr>
                                <th>{item.id === "rates" ? "currency" : "team"}</th>
                                <th>
                                  {item.id === "targets"
                                    ? "target"
                                    : item.id === "rates"
                                      ? "rate"
                                      : "calls"}
                                </th>
                              </tr>
                            </thead>
                            <tbody>
                              {previewRows.map((row) => (
                                <tr key={row[0]}>
                                  {row.map((value) => (
                                    <td key={value}>{value}</td>
                                  ))}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      ))}
                    {item.id === "usage" && !missing && scenario !== "future" && (
                      <div className={styles.manage}>
                        <button
                          className={styles.plainButton}
                          onClick={() => setReplacement(!replacement)}
                          aria-expanded={replacement}
                        >
                          Replace data… <ArrowRight size={14} />
                        </button>
                        {replacement && (
                          <div className={styles.impact}>
                            <h4>Review replacement</h4>
                            <p>usage-nov15.parquet</p>
                            <p>
                              <Check size={14} /> 2 following views will update.
                            </p>
                            <p>
                              <Pin size={14} /> Quarterly snapshot stays on v5.
                            </p>
                            <Button
                              size="sm"
                              onClick={() => {
                                setChanged(true);
                                setReplacement(false);
                              }}
                            >
                              Apply demo replacement
                            </Button>
                          </div>
                        )}
                      </div>
                    )}
                    {item.kind === "source" && !missing && (
                      <small className={styles.attribution}>
                        *Client-provided agent label. Sample provenance.
                      </small>
                    )}
                  </div>
                )}
              </>
            )}
          </aside>
        )}
      </div>
      <section className={styles.notes}>
        <div>
          <h2>One place to inspect</h2>
          <p>
            Open a source from the title, see its full name, history and uses, then follow a
            connection in either direction. Closing the panel returns to the clean reading view.
          </p>
        </div>
        <div>
          <h2>A map with a job</h2>
          <p>
            The default view answers “what uses this?” The expanded map answers “how did this get
            here?” Selection connects the two; pinned edges stay visibly distinct.
          </p>
        </div>
        <div>
          <h2>Room to grow</h2>
          <p>
            Calculations and their results remain separate. Custom rendering belongs to a view. The
            future example explores this vocabulary without choosing where execution or results
            live.
          </p>
        </div>
      </section>
    </Root>
  );
}
