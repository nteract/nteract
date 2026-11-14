"use client";

import { useState } from "react";
import { Check, ChevronDown, Database, Ellipsis, MessageSquare, Share2, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import styles from "./pages-sources-line-example.module.css";

type LabelStyle = "none" | "text" | "icon";
type Source = { name: string; when: string; instant: string; version: number };
const counts = [0, 1, 2, 3, 8, 64] as const;
// Fixed examples: this is a design fixture, not a clock or a sources client.
const usage: Source = {
  name: "Usage",
  when: "2 hours ago",
  instant: "2026-11-14T15:00:00Z",
  version: 3,
};
const sales: Source = {
  name: "Sales",
  when: "1 day ago",
  instant: "2026-11-13T17:00:00Z",
  version: 2,
};
const targets: Source = {
  name: "Targets",
  when: "Nov 2",
  instant: "2026-11-02T17:00:00Z",
  version: 1,
};
const fixtureNames = [
  "Accounts",
  "Deployments",
  "Errors",
  "Latency",
  "Sales",
  "Sessions",
  "Targets",
  "Usage",
];

function sourcesFor(count: number, longNames: boolean): Source[] {
  const sources =
    count === 0
      ? []
      : count === 1
        ? [usage]
        : count === 2
          ? [sales, usage]
          : count === 3
            ? [sales, targets, usage]
            : Array.from({ length: count }, (_, index) => ({
                version: index === 0 ? 1 : 2,
                name: fixtureNames[index] ?? `Workspace ${String(index + 1).padStart(2, "0")}`,
                when: index === 0 ? "Oct 2" : index === count - 1 ? "2 hours ago" : "1 day ago",
                instant:
                  index === 0
                    ? "2026-10-02T17:00:00Z"
                    : index === count - 1
                      ? usage.instant
                      : sales.instant,
              }));
  return longNames
    ? sources.map((source) => ({ ...source, name: `${source.name} across production workspaces` }))
    : sources;
}

function SourceEntry({ source, icon = false }: { source: Source; icon?: boolean }) {
  return (
    <span className={styles.sourceEntry}>
      <span className={styles.sourceName} title={source.name}>
        {icon && <Database size={13} strokeWidth={1.5} aria-hidden="true" />}
        <span className={styles.sourceNameText}>{source.name}</span>
      </span>
      <span aria-hidden="true"> · </span>
      <span>
        {source.version === 1 ? "added" : "refreshed"}{" "}
        <time
          dateTime={source.instant}
          title={`${source.instant} · Set by Daily refresh for Morgan Chen`}
        >
          {source.when}
        </time>
      </span>
    </span>
  );
}

function FreshnessSummary({ sources }: { sources: Source[] }) {
  const sorted = [...sources].sort((a, b) => a.instant.localeCompare(b.instant));
  const oldest = sorted[0];
  const newest = sorted[sorted.length - 1];
  return (
    <span className={styles.summary}>
      <span className={styles.sourceName}>{sources.length} sources</span>
      <span>
        · newest <time dateTime={newest.instant}>{newest.when}</time>
      </span>
      <span>
        · oldest <time dateTime={oldest.instant}>{oldest.when}</time>
      </span>
    </span>
  );
}

/** Plain, noninteractive text. No placeholder or reserved space when empty. */
function SourcesLine({ sources, labelStyle }: { sources: Source[]; labelStyle: LabelStyle }) {
  if (!sources.length) return null;
  const icon =
    labelStyle === "icon" ? <Database size={13} strokeWidth={1.5} aria-hidden="true" /> : null;
  const entries = (
    <span className={styles.sourceGroup} data-labeled={labelStyle === "text"}>
      {labelStyle === "text" && (
        <strong className={styles.sourceLabel}>
          {sources.length === 1 ? "Source" : "Sources"}
        </strong>
      )}
      <span className={styles.sourceItems}>
        {sources.map((source) => (
          <SourceEntry key={source.name} source={source} icon={labelStyle === "icon"} />
        ))}
      </span>
    </span>
  );
  const summary = (
    <span className={styles.summaryGroup}>
      {icon}
      <FreshnessSummary sources={sources} />
    </span>
  );
  return (
    <div
      className={styles.sourcesLine}
      aria-label="Page sources"
      data-source-count={sources.length}
    >
      {sources.length <= 2 ? (
        entries
      ) : sources.length === 3 ? (
        <>
          <span className={styles.wideEntries}>{entries}</span>
          <span className={styles.narrowSummary}>{summary}</span>
        </>
      ) : (
        summary
      )}
    </div>
  );
}

function DocumentBody() {
  return (
    <div className={styles.body}>
      <p>
        How people and agents use tools across the workspace. The views below follow our daily usage
        data.
      </p>
      <h2>Activity over time</h2>
      <p>Tool calls by day, grouped by where they happened.</p>
      <div className={styles.chart} aria-label="Illustrative activity chart">
        <div className={styles.bars}>
          {[35, 54, 46, 68, 57, 83, 74, 65, 92, 79, 86, 96].map((height, index) => (
            <div key={index} style={{ height: `${height}%` }}>
              <span style={{ height: `${30 + (index % 3) * 6}%` }} />
            </div>
          ))}
        </div>
        <div className={styles.chartAxis}>
          <span>Nov 3</span>
          <span>Nov 7</span>
          <span>Nov 10</span>
          <span>Nov 14</span>
        </div>
        <div className={styles.legend}>
          <span>
            <i /> MCP
          </span>
          <span>
            <i /> Browser
          </span>
        </div>
      </div>
    </div>
  );
}

function DocumentPreview({
  count,
  theme,
  labelStyle,
  longNames = false,
  compact = false,
}: {
  count: number;
  theme: "light" | "dark";
  labelStyle: LabelStyle;
  longNames?: boolean;
  compact?: boolean;
}) {
  const sources = sourcesFor(count, longNames);
  return (
    <div
      className={`${styles.pageFrame} ${compact ? styles.compact : ""}`}
      data-theme={theme}
      data-preview-count={count}
    >
      {!compact && (
        <div className={styles.appHeader} aria-hidden="true">
          <span className={styles.brand}>
            Pages <ChevronDown size={14} />
          </span>
          <div className={styles.appActions}>
            <span>
              <Check size={14} /> Saved
            </span>
            <span className={styles.presence}>
              <Users size={17} /> 2
            </span>
            <span className={styles.share}>
              <Share2 size={17} /> Share
            </span>
            <MessageSquare size={19} />
            <Ellipsis size={21} />
            <span className={styles.avatar}>MC</span>
          </div>
        </div>
      )}
      <article className={`${styles.paper} ${sources.length ? styles.hasSources : ""}`}>
        <h1 className={styles.title}>Workspace usage</h1>
        <SourcesLine sources={sources} labelStyle={labelStyle} />
        {compact ? (
          <p className={styles.excerpt}>How people and agents use tools across the workspace.</p>
        ) : (
          <DocumentBody />
        )}
      </article>
    </div>
  );
}

export function PagesSourcesLineExample({ embedded = false }: { embedded?: boolean }) {
  const [count, setCount] = useState(1);
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [phone, setPhone] = useState(false);
  const [labelStyle, setLabelStyle] = useState<LabelStyle>("icon");
  const [longNames, setLongNames] = useState(false);
  const Root = embedded ? "div" : "main";
  return (
    <Root className={`${styles.exploration} ${embedded ? styles.embedded : ""}`}>
      <header className={styles.intro}>
        <span className={styles.eyebrow}>PAGES · DESIGN STUDY</span>
        <h1>Sources, just below the title.</h1>
        <p>A small freshness line for data-backed Pages. No sources means no change.</p>
      </header>
      <div className={styles.controls} aria-label="Mockup controls">
        <fieldset>
          <legend>Sources</legend>
          <div>
            {counts.map((value) => (
              <Button
                key={value}
                size="sm"
                variant={count === value ? "secondary" : "ghost"}
                aria-pressed={count === value}
                onClick={() => setCount(value)}
              >
                {value}
              </Button>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend>Appearance</legend>
          <div>
            {(["light", "dark"] as const).map((value) => (
              <Button
                key={value}
                size="sm"
                variant={theme === value ? "secondary" : "ghost"}
                aria-pressed={theme === value}
                onClick={() => setTheme(value)}
              >
                {value === "light" ? "Light" : "Dark"}
              </Button>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend>Width</legend>
          <div>
            {[false, true].map((value) => (
              <Button
                key={String(value)}
                size="sm"
                variant={phone === value ? "secondary" : "ghost"}
                aria-pressed={phone === value}
                onClick={() => setPhone(value)}
              >
                {value ? "Phone" : "Desktop"}
              </Button>
            ))}
          </div>
        </fieldset>
        <label className={styles.longNames}>
          <input
            type="checkbox"
            checked={longNames}
            onChange={(event) => setLongNames(event.target.checked)}
          />{" "}
          Long source names
        </label>
      </div>
      <div className={styles.previewStage}>
        <div className={phone ? styles.phone : styles.desktop} data-main-preview>
          <DocumentPreview
            count={count}
            theme={theme}
            labelStyle={labelStyle}
            longNames={longNames}
          />
        </div>
      </div>
      <section className={styles.comparison} aria-label="Compare source counts">
        <div className={styles.sectionHeading}>
          <h2>From none to many</h2>
          <p>Same title and body. Only the source line changes.</p>
        </div>
        <div className={styles.grid} data-contact-sheet>
          {counts.map((value) => (
            <figure key={value} className={styles.example}>
              <figcaption>
                <strong>
                  {value === 0 ? "No sources" : `${value} ${value === 1 ? "source" : "sources"}`}
                </strong>
                <span>
                  {value === 0
                    ? "Current spacing, unchanged"
                    : value <= 3
                      ? "Name and refresh time"
                      : "One summary for the whole Page"}
                </span>
              </figcaption>
              <DocumentPreview
                count={value}
                theme={theme}
                labelStyle={labelStyle}
                longNames={longNames}
                compact
              />
            </figure>
          ))}
        </div>
      </section>
      <section className={styles.comparison} aria-label="Source label alternatives">
        <div className={styles.sectionHeading}>
          <h2>Make the source context explicit</h2>
          <p>The freshness summary is settled. Compare how a single source identifies itself.</p>
        </div>
        <div className={styles.labelOptions}>
          {(
            [
              ["none", "Original · Name only", "Quiet, but can read like a subtitle."],
              [
                "text",
                "A · Source label",
                "A separate label identifies the line as source metadata.",
              ],
              [
                "icon",
                "B · Icon on each source",
                "The source name carries its own cue. No separate Source label.",
              ],
            ] as const
          ).map(([value, label, description]) => (
            <div className={styles.option} key={value}>
              <Button
                variant={labelStyle === value ? "secondary" : "outline"}
                aria-pressed={labelStyle === value}
                onClick={() => setLabelStyle(value)}
              >
                {label}
              </Button>
              <p>{description}</p>
              <DocumentPreview count={1} theme={theme} labelStyle={value} compact />
            </div>
          ))}
        </div>
      </section>
      <p className={styles.footnote}>
        Design fixture · fixed example dates and data · no live Page or source writes.
      </p>
    </Root>
  );
}
