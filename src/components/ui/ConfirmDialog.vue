<template>
  <Teleport to="body">
    <div
      v-if="confirmState.open"
      class="confirm-backdrop"
      @click.self="resolveConfirm(false)"
    >
      <section
        class="confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="global-confirm-title"
      >
        <header class="confirm-header">
          <h2 id="global-confirm-title">{{ confirmState.title }}</h2>
          <button type="button" class="confirm-close" aria-label="关闭" @click="resolveConfirm(false)">
            <UiIcon name="x" :size="16" />
          </button>
        </header>
        <p class="confirm-message">{{ confirmState.message }}</p>
        <footer class="confirm-actions">
          <button type="button" class="btn btn-secondary" @click="resolveConfirm(false)">
            {{ confirmState.cancelText }}
          </button>
          <button
            ref="confirmBtnRef"
            type="button"
            class="btn"
            :class="confirmState.danger ? 'btn-disconnect' : 'btn-connect'"
            @click="resolveConfirm(true)"
          >
            {{ confirmState.confirmText }}
          </button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<script setup>
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import UiIcon from '../UiIcon.vue'
import { useToastStore } from '../../stores/toastStore.js'

const { confirmState, resolveConfirm } = useToastStore()
const confirmBtnRef = ref(null)

function onKeyDown(e) {
  if (confirmState.open && e.key === 'Escape') {
    resolveConfirm(false)
  }
}

watch(() => confirmState.open, (open) => {
  if (open) {
    nextTick(() => confirmBtnRef.value?.focus())
  }
})

onMounted(() => window.addEventListener('keydown', onKeyDown))
onUnmounted(() => window.removeEventListener('keydown', onKeyDown))
</script>

<style scoped>
.confirm-backdrop {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: grid;
  place-items: center;
  padding: 20px;
  background: rgba(2, 8, 18, 0.72);
  backdrop-filter: blur(6px);
}

.confirm-dialog {
  width: min(420px, 100%);
  padding: 20px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-lg);
  background: var(--bg-card);
  box-shadow: 0 22px 50px rgba(0, 0, 0, 0.45);
}

.confirm-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.confirm-header h2 {
  font-size: 1rem;
  font-weight: 650;
  color: var(--text-primary);
}

.confirm-close {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border: 0;
  border-radius: 7px;
  color: var(--text-muted);
  background: transparent;
  cursor: pointer;
}

.confirm-close:hover {
  color: var(--text-primary);
  background: var(--bg-soft);
}

.confirm-message {
  margin-top: 12px;
  color: var(--text-secondary);
  font-size: var(--text-base);
  line-height: 1.65;
}

.confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 20px;
}
</style>
