import { IsolatedFrame, type IsolatedFrameHandle } from "@/components/isolated/isolated-frame";
import { IsolatedRendererProvider } from "@/components/isolated/isolated-renderer-context";
import {
  createNteractOutputEmbed,
  type NteractOutputEmbedHandle,
} from "@/components/isolated/output-embed";
import { injectPluginsForMimes, needsPlugin } from "@/components/isolated/iframe-libraries";
import { createRoot } from "react-dom/client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fixtures, getFixtureOutputs, markdownFixture, type Fixture } from "./fixtures";
import type { OutputBlobResolver } from "@/components/isolated/output-manifest";

type RendererLoader = () => Promise<{ rendererCode: string; rendererCss: string }>;

const defaultRendererLoader: RendererLoader = () => import("virtual:isolated-renderer");

const delayedRendererLoader = async () => {
  await new Promise((resolve) => window.setTimeout(resolve, 300));
  return await import("virtual:isolated-renderer");
};

const emptyCssRendererLoader = async () => {
  const bundle = await import("virtual:isolated-renderer");
  return { rendererCode: bundle.rendererCode, rendererCss: "" };
};

function FixtureCard({
  fixture,
  index,
  statusTestId,
  frameTestId,
  onRendered,
}: {
  fixture: Fixture;
  index: number;
  statusTestId?: string;
  frameTestId?: string;
  onRendered?: () => void;
}) {
  const frameRef = useRef<IsolatedFrameHandle>(null);
  const injectedRef = useRef(new Set<string>());
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onReady = useCallback(async () => {
    const frame = frameRef.current;
    if (!frame) return;

    const outputs = getFixtureOutputs(fixture);
    const pluginMimes = outputs
      .map((output) => output.mimeType)
      .filter((mimeType) => needsPlugin(mimeType));
    if (pluginMimes.length > 0) {
      await injectPluginsForMimes(frame, pluginMimes, injectedRef.current);
    }

    if (outputs.length === 1) {
      const [output] = outputs;
      frame.render({
        mimeType: output.mimeType,
        data: output.data,
        metadata: output.metadata,
        outputId: `fixture-${index}-0`,
        cellId: `fixture-${index}`,
        outputIndex: 0,
      });
    } else {
      frame.renderBatch(
        outputs.map((output, outputIndex) => ({
          mimeType: output.mimeType,
          data: output.data,
          metadata: output.metadata,
          outputId: `fixture-${index}-${outputIndex}`,
          cellId: `fixture-${index}`,
          outputIndex,
        })),
      );
    }

    setReady(true);
    onRendered?.();
  }, [fixture, index, onRendered]);

  return (
    <div
      style={{
        border: "1px solid #e0e0e0",
        borderRadius: 8,
        overflow: "hidden",
        marginBottom: 16,
      }}
    >
      <div
        style={{
          padding: "8px 12px",
          background: "#f5f5f5",
          borderBottom: "1px solid #e0e0e0",
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontFamily: "system-ui, sans-serif",
          fontSize: 13,
        }}
      >
        <span
          data-testid={statusTestId ?? `fixture-status-${index}`}
          data-ready={ready}
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: error ? "#ef4444" : ready ? "#22c55e" : "#d4d4d4",
          }}
        />
        <strong>{fixture.label}</strong>
        <code style={{ color: "#6b7280", fontSize: 11 }}>{fixture.mimeType}</code>
        {error && <span style={{ color: "#ef4444", fontSize: 11 }}>{error}</span>}
      </div>
      <div data-testid={frameTestId ?? `fixture-frame-${index}`}>
        <IsolatedFrame
          ref={frameRef}
          id={`fixture-${index}`}
          onReady={onReady}
          onError={(e) => setError(e.message)}
          minHeight={40}
          maxHeight={400}
        />
      </div>
    </div>
  );
}

function FixtureListApp({ loader = defaultRendererLoader }: { loader?: RendererLoader }) {
  return (
    <IsolatedRendererProvider loader={loader}>
      <div
        style={{
          maxWidth: 900,
          margin: "0 auto",
          padding: "24px 16px",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 4 }}>Renderer Plugin Test</h1>
        <p style={{ color: "#6b7280", fontSize: 13, marginBottom: 24 }}>
          {fixtures.length} fixtures — each rendered in an isolated iframe
        </p>
        {fixtures.map((fixture, i) => (
          <FixtureCard key={i} fixture={fixture} index={i} />
        ))}
      </div>
    </IsolatedRendererProvider>
  );
}

function SingleFixtureApp({ fixture, loader }: { fixture: Fixture; loader: RendererLoader }) {
  return (
    <IsolatedRendererProvider loader={loader}>
      <div style={{ maxWidth: 900, margin: "0 auto", padding: "24px 16px" }}>
        <FixtureCard fixture={fixture} index={0} />
      </div>
    </IsolatedRendererProvider>
  );
}

function RemountScenarioApp() {
  const [version, setVersion] = useState(0);
  const [readyCount, setReadyCount] = useState(0);

  const handleRendered = useCallback(() => {
    setReadyCount((count) => {
      const next = count + 1;
      if (next === 1) {
        window.setTimeout(() => setVersion(1), 100);
      }
      return next;
    });
  }, []);

  return (
    <IsolatedRendererProvider loader={defaultRendererLoader}>
      <div style={{ maxWidth: 900, margin: "0 auto", padding: "24px 16px" }}>
        <div data-testid="remount-status" data-ready-count={readyCount} />
        <FixtureCard
          key={version}
          fixture={markdownFixture}
          index={0}
          frameTestId="remount-frame"
          onRendered={handleRendered}
        />
      </div>
    </IsolatedRendererProvider>
  );
}

function HostContextScenarioApp() {
  const frameRef = useRef<IsolatedFrameHandle>(null);
  const [ready, setReady] = useState(false);
  const [darkMode, setDarkMode] = useState(false);
  const [height, setHeight] = useState(0);

  const hostContext = useMemo(
    () => ({
      styles: {
        variables: {
          "--nteract-host-context-probe": darkMode ? "#123456" : "#654321",
        },
        css: {
          fonts: "",
        },
      },
      locale: "en-US",
      timeZone: "America/Los_Angeles",
      userAgent: "renderer-test",
      platform: "web" as const,
    }),
    [darkMode],
  );

  const onReady = useCallback(() => {
    frameRef.current?.render({
      mimeType: "text/html",
      data: '<div id="host-context-probe" style="color: var(--nteract-host-context-probe); font-family: var(--font-sans);">Host context probe</div>',
      outputId: "host-context-probe",
      cellId: "host-context",
      outputIndex: 0,
    });
    setReady(true);
  }, []);

  useEffect(() => {
    if (!ready) return;
    const timer = window.setTimeout(() => setDarkMode(true), 100);
    return () => window.clearTimeout(timer);
  }, [ready]);

  return (
    <IsolatedRendererProvider loader={defaultRendererLoader}>
      <div style={{ maxWidth: 900, margin: "0 auto", padding: "24px 16px" }}>
        <div
          data-testid="host-context-status"
          data-ready={ready}
          data-height={height}
          data-dark-mode={darkMode}
        />
        <div data-testid="host-context-frame">
          <IsolatedFrame
            ref={frameRef}
            id="host-context"
            darkMode={darkMode}
            hostContext={hostContext}
            minHeight={40}
            maxHeight={420}
            onReady={onReady}
            onResize={setHeight}
          />
        </div>
      </div>
    </IsolatedRendererProvider>
  );
}

function fakeBlobResolver(blobs: Record<string, string>): OutputBlobResolver {
  return {
    url(ref) {
      return `https://renderer-test.invalid/blob/${ref.blob}`;
    },
    async fetch(ref) {
      const body = blobs[ref.blob];
      return new Response(body ?? "", {
        status: body == null ? 404 : 200,
      });
    },
  };
}

function VanillaEmbedScenarioApp() {
  const targetRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<NteractOutputEmbedHandle | null>(null);
  const [height, setHeight] = useState(0);
  const [darkMode, setDarkMode] = useState(false);
  const [diagnostics, setDiagnostics] = useState<string[]>([]);

  useEffect(() => {
    const target = targetRef.current;
    if (!target) return;

    const handle = createNteractOutputEmbed({
      target,
      rendererBundle: defaultRendererLoader,
      blobResolver: fakeBlobResolver({
        pandasHtml:
          "<table><thead><tr><th></th><th>a</th><th>b</th></tr></thead><tbody><tr><th>0</th><td>1</td><td>3</td></tr><tr><th>1</th><td>2</td><td>4</td></tr></tbody></table>",
      }),
      maxHeight: 420,
      hostContext: {
        theme: "light",
        styles: {
          variables: {
            "--vanilla-embed-probe": "#654321",
          },
        },
        locale: "en-US",
        timeZone: "America/Los_Angeles",
        userAgent: "renderer-test-vanilla",
        platform: "web",
      },
      output: [
        {
          output_id: "vanilla-embed-stream",
          output_type: "stream",
          name: "stdout",
          text: "vanilla stream before\n",
        },
        {
          output_id: "vanilla-embed-markdown",
          output_type: "display_data",
          data: {
            "text/markdown":
              "# Vanilla Markdown\n\nRendered by the framework-agnostic embed API.\n\n- one\n- two",
          },
        },
        {
          output_id: "vanilla-embed-html-blob",
          output_type: "display_data",
          data: {
            "text/html": { blob: "pandasHtml", size: 160 },
          },
        },
      ],
      onSizeChanged(size) {
        if (size.height != null) setHeight(size.height);
      },
      onDiagnostic(phase) {
        setDiagnostics((prev) => [...prev.slice(-8), phase]);
      },
    });
    handleRef.current = handle;

    const timer = window.setTimeout(() => {
      setDarkMode(true);
      handle.setHostContext({
        theme: "dark",
        styles: {
          variables: {
            "--vanilla-embed-probe": "#123456",
          },
        },
      });
    }, 150);

    return () => {
      window.clearTimeout(timer);
      handle.dispose();
      handleRef.current = null;
    };
  }, []);

  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: "24px 16px" }}>
      <div
        data-testid="vanilla-embed-status"
        data-height={height}
        data-dark-mode={darkMode}
        data-diagnostics={diagnostics.join(",")}
      />
      <div data-testid="vanilla-embed-frame" ref={targetRef} />
    </div>
  );
}

function VanillaRemountScenarioApp() {
  const targetRef = useRef<HTMLDivElement>(null);
  const [version, setVersion] = useState(0);
  const [readyCount, setReadyCount] = useState(0);

  useEffect(() => {
    const target = targetRef.current;
    if (!target) return;

    const handle = createNteractOutputEmbed({
      target,
      rendererBundle: defaultRendererLoader,
      output: {
        outputId: `vanilla-remount-${version}`,
        mimeType: "text/html",
        data: `<div id="vanilla-remount-probe">vanilla remount ${version}</div>`,
      },
      onDiagnostic(phase) {
        if (phase !== "render-complete") return;
        setReadyCount((count) => {
          const next = count + 1;
          if (next === 1) {
            window.setTimeout(() => setVersion(1), 100);
          }
          return next;
        });
      },
    });

    return () => handle.dispose();
  }, [version]);

  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: "24px 16px" }}>
      <div data-testid="vanilla-remount-status" data-ready-count={readyCount} />
      <div data-testid="vanilla-remount-frame" ref={targetRef} />
    </div>
  );
}

function App() {
  const scenario = new URLSearchParams(window.location.search).get("scenario");
  if (scenario === "delayed-bundle") {
    return <SingleFixtureApp fixture={markdownFixture} loader={delayedRendererLoader} />;
  }
  if (scenario === "empty-css") {
    return <SingleFixtureApp fixture={fixtures[0]!} loader={emptyCssRendererLoader} />;
  }
  if (scenario === "remount") {
    return <RemountScenarioApp />;
  }
  if (scenario === "host-context") {
    return <HostContextScenarioApp />;
  }
  if (scenario === "vanilla-embed") {
    return <VanillaEmbedScenarioApp />;
  }
  if (scenario === "vanilla-remount") {
    return <VanillaRemountScenarioApp />;
  }
  return <FixtureListApp />;
}

createRoot(document.getElementById("root")!).render(<App />);
