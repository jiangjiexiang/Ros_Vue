import { computed, getCurrentInstance } from 'vue'

export const MISSION_PATHS = {
  list: '/missions',
  create: '/missions/new',
  edit: (id) => `/missions/${encodeURIComponent(id)}/edit`,
  run: (id) => `/missions/${encodeURIComponent(id)}/run`
}

export function useMissionNavigation(props = {}, emit) {
  const instance = getCurrentInstance()
  const globals = instance?.appContext.config.globalProperties || {}
  const router = globals.$router
  const route = globals.$route

  const routeMissionId = computed(() => String(
    props.missionId || props.id || route?.params?.missionId || route?.params?.id || ''
  ))

  function navigate(path, missionId = '') {
    const detail = { path, missionId }
    emit?.('navigate', detail)
    if (router?.push) {
      router.push(path)
    } else if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('robot-console:mission-navigate', { detail }))
    }
  }

  return { routeMissionId, navigate }
}
