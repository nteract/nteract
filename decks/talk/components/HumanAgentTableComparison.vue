<script setup lang="ts">
import AgentTableSummary from "./AgentTableSummary.vue";
import NteractOutput from "./NteractOutput.vue";
</script>

<template>
  <section class="human-agent-grid">
    <div>
      <NteractOutput label="Human view · Sift table" fixture="mathnet-table" :max-height="440" />
    </div>
    <div>
      <AgentTableSummary />
    </div>
  </section>
</template>

<style scoped>
.human-agent-grid {
  align-items: start;
  display: grid;
  gap: 0.8rem;
  grid-template-columns: minmax(0, 1fr) minmax(0, 0.9fr);
  width: 100%;
}

.human-agent-grid > * {
  min-width: 0;
}

.human-agent-grid :deep(.nteract-output) {
  margin: 0;
  max-width: none;
  width: 100%;
}
</style>
