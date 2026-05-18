<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import FRAME_HTML from "../../../src/components/isolated/frame.html?raw";
import rendererCode from "../../../apps/notebook/src/renderer-plugins/isolated-renderer.js?raw";
import rendererCss from "../../../apps/notebook/src/renderer-plugins/isolated-renderer.css?raw";

interface RenderPayload {
  mimeType: string;
  data: unknown;
  metadata?: Record<string, unknown>;
  outputId?: string;
  cellId?: string;
  outputIndex?: number;
}

const props = withDefaults(
  defineProps<{
    /** The output payload to render inside the sandboxed iframe. */
    payload: RenderPayload;
    /** Initial iframe height; grows in response to renderer resize messages. */
    height?: string;
    /** Optional caption shown above the frame for slide narration. */
    label?: string;
  }>(),
  {
    height: "360px",
  },
);

const frameRef = ref<HTMLIFrameElement | null>(null);
const currentHeight = ref(props.height);
const status = ref<"booting" | "installing" | "ready" | "error">("booting");
const errorMessage = ref<string | null>(null);

let pendingInstall = true;
let pendingRender = true;
let nextRequestId = 1;

watch(
  () => props.payload,
  () => {
    pendingRender = true;
    sendRenderIfReady();
  },
  { deep: false },
);

function frameWindow(): Window | null {
  return frameRef.value?.contentWindow ?? null;
}

function notify(method: string, params: unknown) {
  const win = frameWindow();
  if (!win) return;
  win.postMessage({ jsonrpc: "2.0", method, params }, "*");
}

function legacy(type: string, payload: unknown) {
  const win = frameWindow();
  if (!win) return;
  win.postMessage({ type, payload }, "*");
}

function sendInstall() {
  if (!pendingInstall) return;
  pendingInstall = false;
  status.value = "installing";
  console.log(
    "[isolated-frame] -> install_renderer",
    { codeLen: rendererCode.length, cssLen: rendererCss.length },
  );
  // The iframe's bootstrap listener accepts both legacy and JSON-RPC
  // install messages; legacy is used here because it's handled before
  // the React app mounts inside the iframe.
  legacy("install_renderer", { code: rendererCode, css: rendererCss });
}

function sendRenderIfReady() {
  if (status.value !== "ready") return;
  if (!pendingRender) return;
  pendingRender = false;
  console.log("[isolated-frame] -> renderOutput", {
    mimeType: props.payload.mimeType,
    dataType: typeof props.payload.data,
  });
  notify("nteract/renderOutput", {
    mimeType: props.payload.mimeType,
    data: props.payload.data,
    metadata: props.payload.metadata,
    outputId: props.payload.outputId ?? "talk-output",
    cellId: props.payload.cellId ?? "talk-cell",
    outputIndex: props.payload.outputIndex ?? 0,
    replace: true,
  });
}

function handleMessage(event: MessageEvent) {
  if (event.source !== frameWindow()) return;
  const data = event.data;
  if (!data || typeof data !== "object") return;
  const d = data as Record<string, unknown>;
  console.log(
    "[isolated-frame] <-",
    d.jsonrpc ? `jsonrpc:${String(d.method)}` : `legacy:${String(d.type)}`,
    d.params || d.payload || {},
  );

  // JSON-RPC messages from the iframe.
  if ((data as { jsonrpc?: unknown }).jsonrpc === "2.0") {
    const method = (data as { method?: string }).method;
    const params = (data as { params?: unknown }).params;
    if (method === "nteract/rendererReady") {
      // Renderer plugin bundle has mounted inside the iframe; safe to
      // send the actual output payload.
      status.value = "ready";
      sendRenderIfReady();
    } else if (method === "nteract/resize") {
      const height = (params as { height?: number } | undefined)?.height;
      if (typeof height === "number" && height > 0) {
        currentHeight.value = `${Math.ceil(height)}px`;
      }
    } else if (method === "nteract/error") {
      const message =
        (params as { message?: string } | undefined)?.message ?? "iframe renderer error";
      status.value = "error";
      errorMessage.value = message;
    }
    return;
  }

  // Legacy { type, payload } messages. The bootstrap "ready" only means
  // frame.html's DOM listener is alive — it's the cue to install the
  // plugin bundle, not to send a render payload.
  const type = (data as { type?: string }).type;
  const payload = (data as { payload?: unknown }).payload;
  if (type === "ready" || type === "nteract/ready") {
    sendInstall();
  } else if (type === "nteract/resize") {
    const height = (payload as { height?: number } | undefined)?.height;
    if (typeof height === "number" && height > 0) {
      currentHeight.value = `${Math.ceil(height)}px`;
    }
  }
}

function onIframeLoad() {
  sendInstall();
  // Belt-and-braces: if no rendererReady arrives within 1.5s after install
  // (some renderer paths may not surface the explicit ack), assume the
  // bundle is up and attempt to render.
  window.setTimeout(() => {
    if (status.value === "installing") {
      console.warn("[isolated-frame] no rendererReady after 1.5s — rendering optimistically");
      status.value = "ready";
      sendRenderIfReady();
    }
  }, 1500);
}

onMounted(() => {
  window.addEventListener("message", handleMessage);
});

onBeforeUnmount(() => {
  window.removeEventListener("message", handleMessage);
});

// expose for debugging
defineExpose({ status, errorMessage });
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _id = nextRequestId; // keep linter happy until we use request IDs
</script>

<template>
  <figure class="isolated-frame">
    <figcaption v-if="label" class="isolated-frame__caption">{{ label }}</figcaption>
    <div
      v-if="status === 'error'"
      class="isolated-frame__status isolated-frame__status--error"
    >
      iframe renderer error: {{ errorMessage }}
    </div>
    <iframe
      ref="frameRef"
      :srcdoc="FRAME_HTML"
      :style="{ height: currentHeight }"
      class="isolated-frame__iframe"
      sandbox="allow-scripts allow-downloads allow-forms allow-pointer-lock"
      allow="fullscreen"
      :title="label ?? 'nteract isolated output'"
      @load="onIframeLoad"
    />
  </figure>
</template>

<style scoped>
.isolated-frame {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  width: 100%;
}
.isolated-frame__caption {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.875rem;
  opacity: 0.7;
}
.isolated-frame__iframe {
  width: 100%;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 0.5rem;
  background: white;
  transition: height 120ms ease-out;
}
.isolated-frame__status--error {
  color: #f87171;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.875rem;
}
</style>
