<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import type { NteractEmbeddableOutput } from "@/components/isolated/embeddable-output";
import type { NteractEmbedHostContextPatch } from "@/components/isolated/host-context";
import {
  createNteractOutputEmbed,
  type NteractOutputEmbedHandle,
} from "@/components/isolated/output-embed";
import type { OutputBlobResolver } from "@/components/isolated/output-manifest";
import type { IsolatedFrameRendererBundle } from "@/components/isolated/isolated-frame-runtime";
import {
  agentReplOutputs,
  demoBlobResolver,
  mathnetDataFrameOutput,
  mathnetProblemManifest,
} from "../data/outputs";

type OutputValue = NteractEmbeddableOutput | readonly NteractEmbeddableOutput[];
type RendererBundleModule = IsolatedFrameRendererBundle;
type FixtureName = "agent-repl" | "mathnet-table" | "mathnet-problem-card";

const props = withDefaults(
  defineProps<{
    output?: OutputValue;
    fixture?: FixtureName;
    label?: string;
    autoHeight?: boolean;
    maxHeight?: number;
    dark?: boolean;
    blobResolver?: OutputBlobResolver;
  }>(),
  {
    label: "",
    fixture: undefined,
    autoHeight: true,
    maxHeight: 680,
    dark: false,
    blobResolver: undefined,
  },
);

const targetRef = ref<HTMLElement | null>(null);
const handleRef = shallowRef<NteractOutputEmbedHandle | null>(null);
const status = ref<"mounting" | "rendering" | "ready" | "error">("mounting");
const errorMessage = ref("");
const height = ref(1);
const diagnostics = ref<string[]>([]);

const fixtureOutput = computed<OutputValue | undefined>(() => {
  switch (props.fixture) {
    case "agent-repl":
      return agentReplOutputs;
    case "mathnet-table":
      return mathnetDataFrameOutput;
    case "mathnet-problem-card":
      return mathnetProblemManifest;
    default:
      return undefined;
  }
});

const resolvedOutput = computed(() => props.output ?? fixtureOutput.value);
const resolvedBlobResolver = computed(
  () =>
    props.blobResolver ??
    (props.fixture === "mathnet-problem-card" || props.fixture === "mathnet-table"
      ? demoBlobResolver
      : undefined),
);

const hostContext = computed<NteractEmbedHostContextPatch>(() => ({
  theme: props.dark ? "dark" : "light",
  displayMode: "inline",
  locale: typeof navigator === "undefined" ? undefined : navigator.language,
  timeZone:
    typeof Intl === "undefined" ? undefined : Intl.DateTimeFormat().resolvedOptions().timeZone,
  platform: "web",
  userAgent: typeof navigator === "undefined" ? undefined : navigator.userAgent,
  styles: {
    variables: {
      "--nteract-host-accent": props.dark ? "#93c5fd" : "#2563eb",
      "--nteract-host-output-border": props.dark
        ? "rgb(148 163 184 / 0.28)"
        : "rgb(15 23 42 / 0.14)",
    },
    css: {
      fonts: "",
    },
  },
}));

async function loadRendererBundle(): Promise<RendererBundleModule> {
  return await import("virtual:isolated-renderer");
}

function recordDiagnostic(phase: string, details?: Record<string, unknown>) {
  const suffix = details?.height ? ` (${details.height}px)` : "";
  diagnostics.value = [`${phase}${suffix}`, ...diagnostics.value].slice(0, 4);
}

async function renderOutput(output: OutputValue | undefined) {
  const handle = handleRef.value;
  if (!handle || !output) return;
  status.value = "rendering";
  errorMessage.value = "";
  try {
    if (Array.isArray(output)) {
      await handle.renderBatch(output);
    } else {
      await handle.render(output);
    }
    status.value = "ready";
  } catch (error) {
    status.value = "error";
    errorMessage.value = error instanceof Error ? error.message : String(error);
  }
}

onMounted(async () => {
  await nextTick();
  const target = targetRef.value;
  if (!target) return;

  const handle = createNteractOutputEmbed({
    target,
    rendererBundle: loadRendererBundle,
    hostContext: hostContext.value,
    blobResolver: resolvedBlobResolver.value,
    autoHeight: props.autoHeight,
    maxHeight: props.maxHeight,
    onSizeChanged(size) {
      if (size.height !== undefined) height.value = size.height;
    },
    onDiagnostic(phase, details) {
      recordDiagnostic(phase, details);
    },
    onError(error) {
      status.value = "error";
      errorMessage.value = error.message;
    },
  });
  handleRef.value = handle;
  await renderOutput(resolvedOutput.value);
});

watch(
  resolvedOutput,
  (output) => {
    void renderOutput(output);
  },
  { deep: true },
);

watch(
  hostContext,
  (context) => {
    handleRef.value?.setHostContext(context);
  },
  { deep: true },
);

onBeforeUnmount(() => {
  handleRef.value?.dispose();
  handleRef.value = null;
});
</script>

<template>
  <figure class="nteract-output" :data-status="status">
    <figcaption v-if="label" class="nteract-output-caption">
      <span>{{ label }}</span>
      <span class="nteract-output-meta">{{ status }} · {{ height }}px</span>
    </figcaption>
    <div ref="targetRef" class="nteract-output-target" />
    <p v-if="status === 'error'" class="nteract-output-error">{{ errorMessage }}</p>
    <p v-else-if="diagnostics.length > 0" class="nteract-output-diagnostics">
      {{ diagnostics.join(" / ") }}
    </p>
  </figure>
</template>

<style scoped>
.nteract-output {
  background: rgb(255 255 255 / 0.92);
  border: 1px solid var(--nteract-host-output-border, rgb(15 23 42 / 0.14));
  border-radius: 8px;
  box-shadow: 0 18px 48px rgb(15 23 42 / 0.12);
  margin: 1rem auto;
  max-width: 58rem;
  overflow: hidden;
  text-align: left;
}

.nteract-output[data-status="error"] {
  border-color: rgb(220 38 38 / 0.45);
}

.nteract-output-caption {
  align-items: center;
  background: rgb(248 250 252 / 0.92);
  border-bottom: 1px solid rgb(15 23 42 / 0.1);
  color: #0f172a;
  display: flex;
  font-family: ui-sans-serif, system-ui, sans-serif;
  font-size: 0.82rem;
  font-weight: 650;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.55rem 0.75rem;
}

.nteract-output-meta,
.nteract-output-diagnostics {
  color: #64748b;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  font-size: 0.68rem;
  font-weight: 500;
}

.nteract-output-target {
  min-height: 1px;
}

.nteract-output-error {
  color: #b91c1c;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  font-size: 0.75rem;
  margin: 0;
  padding: 0.75rem;
}

.nteract-output-diagnostics {
  border-top: 1px solid rgb(15 23 42 / 0.08);
  margin: 0;
  overflow: hidden;
  padding: 0.4rem 0.75rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
