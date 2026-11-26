<template>
  <AppShell>
    <RouterView />
  </AppShell>
  <ToastHost />
  <ConfirmDialog />
</template>

<script setup>
import { onMounted, onUnmounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import AppShell from './layout/AppShell.vue'
import ToastHost from './components/ui/ToastHost.vue'
import ConfirmDialog from './components/ui/ConfirmDialog.vue'
import { useRuntimeConfigStore } from './stores/runtimeConfigStore.js'
import { useRobotStore } from './stores/robotStore.js'
import { useInspectionStore } from './stores/inspectionStore.js'
import { useRosSessionStore } from './stores/rosSessionStore.js'
import { useMissionStore } from './features/missions/missionStore.js'

const route = useRoute()
const { loadRuntimeConfig } = useRuntimeConfigStore()
const { loadRobotsFromServer } = useRobotStore()
const { initInspectionStore } = useInspectionStore()
const { setKeyboardEnabled, onStopMotion, initRosSession, disposeRosSession } = useRosSessionStore()
const { initMissionsFromServer } = useMissionStore()
let disposed = false

function withTimeout(promise, timeoutMs) {
  let timer = null
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`初始化请求超过 ${timeoutMs}ms`)), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

watch(() => route.path, (current, previous) => {
  if (previous === '/inspection' && current !== '/inspection') {
    setKeyboardEnabled(false)
    onStopMotion()
  }
})

onMounted(async () => {
  disposed = false
  void initInspectionStore()
  void initMissionsFromServer()
  await Promise.allSettled([
    withTimeout(loadRuntimeConfig(), 4000),
    withTimeout(loadRobotsFromServer(), 4000)
  ])
  if (!disposed) initRosSession()
})

onUnmounted(() => {
  disposed = true
  disposeRosSession()
})
</script>
