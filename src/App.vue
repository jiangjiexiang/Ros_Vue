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

watch(() => route.path, (current, previous) => {
  if (previous === '/inspection' && current !== '/inspection') {
    setKeyboardEnabled(false)
    onStopMotion()
  }
})

onMounted(async () => {
  await Promise.allSettled([
    loadRuntimeConfig(),
    loadRobotsFromServer(),
    initInspectionStore(),
    initMissionsFromServer()
  ])
  initRosSession()
})

onUnmounted(() => {
  disposeRosSession()
})
</script>
