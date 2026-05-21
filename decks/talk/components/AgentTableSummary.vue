<script setup lang="ts">
import { MATHNET_AGENT_TABLE_SUMMARY } from "../data/mathnet-arrow";
</script>

<template>
  <figure class="agent-table-summary">
    <figcaption>
      <span>Agent view</span>
      <code>text/llm+plain</code>
    </figcaption>
    <pre>{{ MATHNET_AGENT_TABLE_SUMMARY }}</pre>
  </figure>
</template>

<style scoped>
.agent-table-summary {
  background: #0f172a;
  border: 1px solid rgb(148 163 184 / 0.28);
  border-radius: 8px;
  box-shadow: 0 18px 48px rgb(15 23 42 / 0.16);
  color: #dbeafe;
  margin: 0;
  overflow: hidden;
  text-align: left;
}

.agent-table-summary figcaption {
  align-items: center;
  background: rgb(15 23 42 / 0.96);
  border-bottom: 1px solid rgb(148 163 184 / 0.22);
  color: #f8fafc;
  display: flex;
  font-family: ui-sans-serif, system-ui, sans-serif;
  font-size: 0.78rem;
  font-weight: 700;
  gap: 0.75rem;
  justify-content: space-between;
  margin: 0;
  padding: 0.5rem 0.65rem;
}

.agent-table-summary code {
  color: #93c5fd;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  font-size: 0.68rem;
  font-weight: 600;
}

.agent-table-summary pre {
  color: #dbeafe;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  font-size: 0.58rem;
  line-height: 1.38;
  margin: 0;
  max-height: 22.5rem;
  overflow: hidden;
  padding: 0.65rem;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
