<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import type { Subscription } from "rxjs";
import {
  ISOLATED_FRAME_SANDBOX,
  IsolatedFrameController,
  resolveFrameSource,
} from "../../../src/components/isolated/isolated-frame-controller";
import type {
  FrameLifecycleState,
  FrameSource,
} from "../../../src/components/isolated/isolated-frame-controller";
import rendererCode from "../../../apps/notebook/src/renderer-plugins/isolated-renderer.js?raw";
import rendererCss from "../../../apps/notebook/src/renderer-plugins/isolated-renderer.css?raw";
import siftPluginCode from "../../../apps/notebook/src/renderer-plugins/sift.js?raw";
import siftPluginCss from "../../../apps/notebook/src/renderer-plugins/sift.css?raw";

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
    /**
     * Whether the renderer inside the iframe should use its dark theme.
     * Defaults to false to match the seriph slide background; flip when
     * the deck switches to a dark theme.
     */
    isDark?: boolean;
  }>(),
  {
    height: "360px",
    isDark: false,
  },
);

const frameRef = ref<HTMLIFrameElement | null>(null);
const currentHeight = ref(props.height);
const state = ref<FrameLifecycleState>("booting");
const errorMessage = ref<string | null>(null);
// Resolve synchronously so the <iframe> renders on the first paint and
// onMounted can instantiate the controller before the bootstrap script
// inside the iframe posts `ready`.
const frameSource = shallowRef<FrameSource>(resolveFrameSource());

let controller: IsolatedFrameController | null = null;
const subs: Subscription[] = [];

function buildPayload(p: RenderPayload) {
  return {
    mimeType: p.mimeType,
    data: p.data,
    metadata: p.metadata,
    outputId: p.outputId ?? "talk-output",
    cellId: p.cellId ?? "talk-cell",
    outputIndex: p.outputIndex ?? 0,
    replace: true,
  };
}

function startController() {
  const iframe = frameRef.value;
  if (!iframe || controller) return;

  controller = new IsolatedFrameController({
    iframe,
    rendererCode,
    rendererCss,
    initialTheme: { isDark: props.isDark, colorTheme: null },
  });

  subs.push(
    controller.state$.subscribe((s) => {
      state.value = s;
      // Install renderer plugins after the base bundle reports ready —
      // the bundle ships built-in renderers, but mime-specific plugins
      // (sift for arrow-stream-manifest, vega, plotly, etc.) are CJS
      // modules that register through the plugin install API. We then
      // hand the actual payload off so the right renderer claims it.
      if (s === "ready") {
        controller!.send({
          type: "install_renderer",
          payload: { code: siftPluginCode, css: siftPluginCss },
        });
        controller!.render(buildPayload(props.payload));
      }
    }),
    controller.resize$.subscribe(({ height }) => {
      if (height > 0) currentHeight.value = `${Math.ceil(height)}px`;
    }),
    controller.errors$.subscribe(({ message }) => {
      errorMessage.value = message;
    }),
  );
}

watch(
  () => props.payload,
  (next) => {
    controller?.render(buildPayload(next));
  },
  { deep: false },
);

watch(
  () => props.isDark,
  (isDark) => {
    controller?.setTheme({ isDark, colorTheme: null });
  },
);

onMounted(() => {
  // Spin up the controller before the iframe finishes loading so its
  // window message listener catches the bootstrap `ready` post.
  startController();
});

onBeforeUnmount(() => {
  for (const sub of subs) sub.unsubscribe();
  subs.length = 0;
  controller?.dispose();
  controller = null;
});

defineExpose({ state, errorMessage });
</script>

<template>
  <figure class="isolated-frame">
    <figcaption v-if="label" class="isolated-frame__caption">{{ label }}</figcaption>
    <div
      v-if="state === 'error' || errorMessage"
      class="isolated-frame__status isolated-frame__status--error"
    >
      iframe renderer error: {{ errorMessage ?? "unknown" }}
    </div>
    <iframe
      ref="frameRef"
      :src="frameSource.kind === 'src' ? frameSource.url : undefined"
      :srcdoc="frameSource.kind === 'srcdoc' ? frameSource.html : undefined"
      :style="{ height: currentHeight }"
      class="isolated-frame__iframe"
      :sandbox="ISOLATED_FRAME_SANDBOX"
      allowfullscreen
      allow="fullscreen *"
      :title="label ?? 'nteract isolated output'"
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
