<script setup lang="ts">
import { onMounted, ref } from "vue";
import { fetchRelayHealth, type RelayHealth } from "../composables/useNteractRelay";

type RelayState =
  | { kind: "loading" }
  | { kind: "ok"; data: RelayHealth }
  | { kind: "error"; message: string };

const state = ref<RelayState>({ kind: "loading" });

onMounted(async () => {
  try {
    state.value = { kind: "ok", data: await fetchRelayHealth() };
  } catch (error) {
    state.value = {
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
});
</script>

<template>
  <div class="relay-status">
    <template v-if="state.kind === 'loading'">
      <span class="muted">probing /__nteract_dev_relay/health...</span>
    </template>
    <template v-else-if="state.kind === 'error'">
      <span class="error">relay error: {{ state.message }}</span>
    </template>
    <template v-else>
      <div><span class="muted">relay</span> {{ state.data.relay }}</div>
      <div>
        <span class="muted">socket</span> {{ state.data.daemon.socket_path ?? "(unknown)" }}
      </div>
      <div><span class="muted">socket present</span> {{ state.data.daemon.socket_exists }}</div>
      <div>
        <span class="muted">daemon</span> {{ state.data.daemon.version ?? "not connected" }}
        <span v-if="state.data.daemon.is_dev_mode" class="ok">(dev)</span>
      </div>
      <div><span class="muted">blob port</span> {{ state.data.blobs.port ?? "n/a" }}</div>
      <div>
        <span class="muted">auth</span> token={{ state.data.auth.token_configured }}, same-origin={{
          state.data.auth.same_origin_required
        }}
      </div>
    </template>
  </div>
</template>

<style scoped>
.relay-status {
  background: rgb(17 24 39 / 0.72);
  border: 1px solid rgb(148 163 184 / 0.22);
  border-radius: 8px;
  color: #f8fafc;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  font-size: 0.78rem;
  line-height: 1.65;
  margin: 0 auto;
  max-width: 45rem;
  padding: 1rem 1.1rem;
  text-align: left;
}

.muted {
  color: #94a3b8;
}

.ok {
  color: #86efac;
}

.error {
  color: #fca5a5;
}
</style>
