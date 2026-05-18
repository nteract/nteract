<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import IsolatedFrame from "./IsolatedFrame.vue";

interface ArrowStreamManifest {
  version?: number;
  content_type?: string;
  schema?: unknown;
  chunks?: Array<{
    index?: number;
    hash?: string;
    url?: string;
    size?: number;
    row_count?: number;
    encoding?: string;
  }>;
  complete?: boolean;
  summary?: unknown;
}

interface RelayConfig {
  blob_port: number | null;
}

const props = defineProps<{
  /**
   * Arrow stream manifest exactly as the daemon emits it for
   * `application/vnd.nteract.arrow-stream-manifest+json`. Chunks may carry
   * `hash` (daemon shape) which we rewrite to `url` against the relay's
   * advertised blob port before sending to the iframe.
   */
  manifest: ArrowStreamManifest;
  label?: string;
}>();

const blobPort = ref<number | null>(null);
const resolveError = ref<string | null>(null);

onMounted(async () => {
  try {
    const res = await fetch("/__nteract_dev_relay/config", { credentials: "same-origin" });
    if (!res.ok) {
      resolveError.value = `relay /config returned ${res.status}`;
      return;
    }
    const cfg = (await res.json()) as RelayConfig;
    if (cfg.blob_port == null) {
      resolveError.value = "daemon did not advertise a blob port";
      return;
    }
    blobPort.value = cfg.blob_port;
  } catch (err) {
    resolveError.value = err instanceof Error ? err.message : String(err);
  }
});

const resolvedManifest = computed<ArrowStreamManifest | null>(() => {
  if (blobPort.value == null) return null;
  const port = blobPort.value;
  const chunks = (props.manifest.chunks ?? []).map((chunk) => {
    if (chunk.url) return chunk;
    if (chunk.hash) {
      return { ...chunk, url: `http://localhost:${port}/blob/${chunk.hash}` };
    }
    return chunk;
  });
  return { ...props.manifest, chunks };
});

const payload = computed(() =>
  resolvedManifest.value
    ? {
        mimeType: "application/vnd.nteract.arrow-stream-manifest+json",
        data: resolvedManifest.value,
      }
    : null,
);
</script>

<template>
  <div class="nteract-sift">
    <template v-if="resolveError">
      <div class="nteract-sift__error">sift cell error: {{ resolveError }}</div>
    </template>
    <template v-else-if="payload">
      <IsolatedFrame :payload="payload" :label="label" height="380px" />
    </template>
    <template v-else>
      <div class="nteract-sift__status">resolving daemon blob port…</div>
    </template>
  </div>
</template>

<style scoped>
.nteract-sift__status,
.nteract-sift__error {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.875rem;
}
.nteract-sift__error {
  color: #f87171;
}
.nteract-sift__status {
  opacity: 0.7;
}
</style>
