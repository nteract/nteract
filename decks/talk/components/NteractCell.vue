<script setup lang="ts">
import { onMounted, ref } from "vue";

interface RelayConfig {
  websocket_url: string;
  token: string;
  blob_port: number | null;
  daemon: { socket_path: string; version: string; is_dev_mode: boolean } | null;
}

const props = withDefaults(
  defineProps<{
    /**
     * Daemon blob hash (sha256) of the rendered output to embed.
     * Look this up by executing the cell once and reading the
     * `text/html` blob ref from the output manifest.
     */
    blob: string;
    /** Media type to render. Pandas DataFrame default is `text/html`. */
    mediaType?: string;
    /** Caption shown above the embed; useful for slide narration. */
    label?: string;
    /** Optional explicit height. Defaults to auto-sized via iframe. */
    height?: string;
  }>(),
  {
    mediaType: "text/html",
    height: "320px",
  },
);

const state = ref<
  | { kind: "loading" }
  | { kind: "ready"; url: string }
  | { kind: "error"; message: string }
>({ kind: "loading" });

onMounted(async () => {
  try {
    const res = await fetch("/__nteract_dev_relay/config", { credentials: "same-origin" });
    if (!res.ok) {
      state.value = { kind: "error", message: `relay /config returned ${res.status}` };
      return;
    }
    const config = (await res.json()) as RelayConfig;
    if (!config.blob_port) {
      state.value = { kind: "error", message: "daemon did not advertise a blob port" };
      return;
    }
    state.value = {
      kind: "ready",
      url: `http://localhost:${config.blob_port}/blob/${props.blob}`,
    };
  } catch (err) {
    state.value = { kind: "error", message: err instanceof Error ? err.message : String(err) };
  }
});
</script>

<template>
  <figure class="nteract-cell">
    <figcaption v-if="label" class="nteract-cell__caption">{{ label }}</figcaption>
    <template v-if="state.kind === 'loading'">
      <div class="nteract-cell__status">resolving daemon blob port…</div>
    </template>
    <template v-else-if="state.kind === 'error'">
      <div class="nteract-cell__status nteract-cell__status--error">
        nteract cell error: {{ state.message }}
      </div>
    </template>
    <template v-else>
      <iframe
        :src="state.url"
        :style="{ height }"
        class="nteract-cell__iframe"
        sandbox="allow-same-origin"
        :title="label ?? 'nteract cell output'"
      />
    </template>
  </figure>
</template>

<style scoped>
.nteract-cell {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  width: 100%;
}
.nteract-cell__caption {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.875rem;
  opacity: 0.7;
}
.nteract-cell__iframe {
  width: 100%;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 0.5rem;
  background: white;
}
.nteract-cell__status {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.875rem;
  opacity: 0.7;
}
.nteract-cell__status--error {
  color: #f87171;
}
</style>
