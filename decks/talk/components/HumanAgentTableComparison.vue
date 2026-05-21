<script setup lang="ts">
import AgentTableSummary from "./AgentTableSummary.vue";
import NteractOutput from "./NteractOutput.vue";
</script>

<template>
  <section class="human-agent-grid">
    <div>
      <p class="view-label">Human sees the rich MIME</p>
      <NteractOutput
        label="ShadenA/MathNet · Arrow stream through Sift"
        fixture="mathnet-table"
        :max-height="440"
      />
    </div>
    <div>
      <p class="view-label">Agent sees the text MIME</p>
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
  margin: 0.35rem 0 0;
  max-width: none;
  width: 100%;
}

.view-label {
  color: #475569;
  font-size: 0.82rem;
  font-weight: 700;
  letter-spacing: 0;
  margin: 0;
  text-align: left;
}
</style>
