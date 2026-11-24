import { reactive, ref } from 'vue'

const toasts = ref([])
let nextToastId = 1

export function showToast(message, type = 'info', duration = 3500) {
  if (!message) return null
  const id = nextToastId++
  toasts.value.push({ id, message: String(message), type })
  if (duration > 0) {
    setTimeout(() => dismissToast(id), duration)
  }
  return id
}

export function dismissToast(id) {
  toasts.value = toasts.value.filter((item) => item.id !== id)
}

const confirmState = reactive({
  open: false,
  title: '确认操作',
  message: '',
  confirmText: '确认',
  cancelText: '取消',
  danger: false
})

let pendingResolve = null

export function confirmDialog({
  title = '确认操作',
  message = '',
  confirmText = '确认',
  cancelText = '取消',
  danger = false
} = {}) {
  if (pendingResolve) {
    pendingResolve(false)
    pendingResolve = null
  }
  Object.assign(confirmState, {
    open: true,
    title,
    message,
    confirmText,
    cancelText,
    danger
  })
  return new Promise((resolve) => {
    pendingResolve = resolve
  })
}

export function resolveConfirm(accepted) {
  confirmState.open = false
  const resolve = pendingResolve
  pendingResolve = null
  if (resolve) resolve(Boolean(accepted))
}

export function useToastStore() {
  return {
    toasts,
    confirmState,
    showToast,
    dismissToast,
    confirmDialog,
    resolveConfirm
  }
}
