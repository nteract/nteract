import { IsolatedFrame, type IsolatedFrameHandle } from "@/components/isolated/isolated-frame";
import { IsolatedRendererProvider } from "@/components/isolated/isolated-renderer-context";
import { injectPluginsForMimes, needsPlugin } from "@/components/isolated/iframe-libraries";
import { createRoot } from "react-dom/client";
import { useCallback, useRef, useState } from "react";
import { fixtures, getFixtureOutputs, markdownFixture, type Fixture } from "./fixtures";

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
        cellId: `fixture-${index}`,
        outputIndex: 0,
      });
    } else {
      frame.renderBatch(
        outputs.map((output, outputIndex) => ({
          mimeType: output.mimeType,
          data: output.data,
          metadata: output.metadata,
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
  return <FixtureListApp />;
}

createRoot(document.getElementById("root")!).render(<App />);
