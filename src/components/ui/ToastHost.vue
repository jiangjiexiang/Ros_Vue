<template>
  <div class="toast-host" aria-live="polite" aria-atomic="false">
    <TransitionGroup name="toast-fade">
      <div
        v-for="item in toasts"
        :key="item.id"
        class="toast-item"
        :class="`toast-${item.type}`"
        role="status"
      >
        <UiIcon :name="iconFor(item.type)" :size="16" />
        <span class="toast-message">{{ item.message }}</span>
        <button type="button" class="toast-close" aria-label="关闭提示" @click="dismissToast(item.id)">
          <UiIcon name="x" :size="14" />
        </button>
      </div>
    </TransitionGroup>
  </div>
</template>

<script setup>
import UiIcon from '../UiIcon.vue'
import { useToastStore } from '../../stores/toastStore.js'

const { toasts, dismissToast } = useToastStore()

function iconFor(type) {
  if (type === 'success') return 'check'
  if (type === 'warning') return 'estop'
  if (type === 'error') return 'estop'
  return 'activity'
}
</script>

<style scoped>
.toast-host {
  position: fixed;
  top: 76px;
  right: 20px;
  z-index: 90;
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: min(360px, calc(100vw - 24px));
  pointer-events: none;
}

.toast-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 11px 13px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-md);
  color: var(--text-primary);
  background: rgba(15, 28, 46, 0.96);
  backdrop-filter: blur(14px);
  box-shadow: 0 14px 30px rgba(0, 0, 0, 0.34);
  font-size: var(--text-sm);
  line-height: 1.45;
  pointer-events: auto;
}

.toast-item > svg {
  flex: 0 0 auto;
  color: var(--accent-primary);
}

.toast-success {
  border-color: rgba(52, 211, 153, 0.35);
}
.toast-success > svg {
  color: var(--success);
}

.toast-warning {
  border-color: rgba(251, 191, 36, 0.35);
}
.toast-warning > svg {
  color: var(--warning);
}

.toast-error {
  border-color: rgba(251, 113, 133, 0.4);
}
.toast-error > svg {
  color: var(--danger);
}

.toast-message {
  flex: 1;
  min-width: 0;
}

.toast-close {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  flex: 0 0 auto;
  border: 0;
  border-radius: 6px;
  color: var(--text-muted);
  background: transparent;
  cursor: pointer;
}

.toast-close:hover {
  color: var(--text-primary);
  background: var(--bg-soft);
}

.toast-fade-enter-active,
.toast-fade-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}

.toast-fade-enter-from,
.toast-fade-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}
</style>
