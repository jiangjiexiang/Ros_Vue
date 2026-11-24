<template>
  <span class="mission-status" :class="`status-${status}`">
    <i aria-hidden="true"></i>{{ label }}
  </span>
</template>

<script setup>
import { computed } from 'vue'
import { getStatusLabel } from './missionModel.js'

const props = defineProps({
  status: { type: String, default: 'pending' }
})

const label = computed(() => getStatusLabel(props.status))
</script>

<style scoped>
.mission-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  width: max-content;
  padding: 4px 8px;
  border: 1px solid var(--border-color);
  border-radius: 20px;
  color: var(--text-secondary);
  background: var(--bg-soft);
  font-size: 0.68rem;
  white-space: nowrap;
}
.mission-status i { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.status-pending { color: var(--text-secondary); }
.status-running { border-color: rgba(52, 211, 153, 0.25); color: var(--success); background: rgba(52, 211, 153, 0.07); }
.status-running i { animation: mission-pulse 1.4s ease-in-out infinite; }
.status-paused { border-color: rgba(251, 191, 36, 0.25); color: var(--warning); background: rgba(251, 191, 36, 0.07); }
.status-completed { border-color: rgba(34, 211, 238, 0.23); color: var(--accent-primary); background: rgba(34, 211, 238, 0.06); }
.status-aborted { border-color: rgba(251, 113, 133, 0.24); color: var(--danger); background: rgba(251, 113, 133, 0.06); }
@keyframes mission-pulse { 50% { opacity: 0.35; } }
@media (prefers-reduced-motion: reduce) { .status-running i { animation: none; } }
</style>
