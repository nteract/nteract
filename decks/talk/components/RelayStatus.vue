<script setup lang="ts">
import { onMounted, ref } from "vue";

interface RelayHealth {
  relay: string;
  paths: { config: string; websocket: string };
  auth: { token_required: boolean; same_origin_required: boolean; token_configured: boolean };
  daemon: {
    socket_path: string | null;
    socket_exists: boolean;
    version: string | null;
    is_dev_mode: boolean | null;
  };
  blobs: { port: number | null };
}

const state = ref<{ kind: "loading" } | { kind: "ok"; data: RelayHealth } | { kind: "error"; message: string }>(
  { kind: "loading" },
);

onMounted(async () => {
  try {
    const res = await fetch("/__nteract_dev_relay/health", { credentials: "same-origin" });
    if (!res.ok) {
      state.value = { kind: "error", message: `health endpoint returned ${res.status}` };
      return;
    }
    state.value = { kind: "ok", data: (await res.json()) as RelayHealth };
  } catch (err) {
    state.value = { kind: "error", message: err instanceof Error ? err.message : String(err) };
  }
});
</script>

<template>
  <div class="text-sm text-left p-4 rounded-lg bg-gray-800/50 max-w-xl mx-auto font-mono">
    <template v-if="state.kind === 'loading'">
      <span class="opacity-50">probing /__nteract_dev_relay/health…</span>
    </template>
    <template v-else-if="state.kind === 'error'">
      <span class="text-red-400">relay error: {{ state.message }}</span>
    </template>
    <template v-else>
      <div><span class="opacity-50">relay</span> {{ state.data.relay }}</div>
      <div><span class="opacity-50">socket</span> {{ state.data.daemon.socket_path ?? "(unknown)" }}</div>
      <div>
        <span class="opacity-50">socket present</span>
        {{ state.data.daemon.socket_exists }}
      </div>
      <div>
        <span class="opacity-50">daemon</span> {{ state.data.daemon.version ?? "not connected" }}
        <span v-if="state.data.daemon.is_dev_mode" class="text-green-300">(dev)</span>
      </div>
      <div><span class="opacity-50">blob port</span> {{ state.data.blobs.port ?? "n/a" }}</div>
      <div class="mt-2">
        <span class="opacity-50">auth</span>
        token={{ state.data.auth.token_configured }},
        same-origin={{ state.data.auth.same_origin_required }}
      </div>
    </template>
  </div>
</template>
