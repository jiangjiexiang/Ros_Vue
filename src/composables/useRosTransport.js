import { computed, shallowRef } from 'vue'
import { useFoxglove } from './useFoxglove.js'
import { useRosbridge } from './useRosbridge.js'
import { useDoglink } from './useDoglink.js'

export function useRosTransport() {
  const foxglove = useFoxglove()
  const rosbridge = useRosbridge()
  const doglink = useDoglink()
  const active = shallowRef(foxglove)

  const connectionState = computed(() => active.value.connectionState.value)
  const errorMessage = computed(() => active.value.errorMessage.value)
  const serverName = computed(() => active.value.serverName.value)
  const serverCapabilities = computed(() => active.value.serverCapabilities.value)
  const rttMs = computed(() => active.value.rttMs?.value ?? null)
  const protocol = computed(() => {
    if (active.value === rosbridge) return 'rosbridge'
    if (active.value === doglink) return 'doglink'
    return 'foxglove'
  })

  function resolveAdapter(targetProtocol) {
    if (targetProtocol === 'rosbridge') return rosbridge
    if (targetProtocol === 'doglink') return doglink
    return foxglove
  }

  function connect(url, targetProtocol = 'foxglove') {
    const next = resolveAdapter(targetProtocol)
    if (active.value !== next) {
      active.value.disconnect()
      active.value = next
    }
    active.value.connect(url)
  }

  function disconnect() {
    active.value.disconnect()
  }

  return {
    connectionState,
    errorMessage,
    serverName,
    serverCapabilities,
    rttMs,
    protocol,
    get availableChannels() { return active.value.availableChannels },
    connect,
    disconnect,
    subscribe: (...args) => active.value.subscribe(...args),
    unsubscribe: (...args) => active.value.unsubscribe(...args),
    clientAdvertise: (...args) => active.value.clientAdvertise(...args),
    publishMessage: (...args) => active.value.publishMessage(...args),
    callService: (...args) => active.value.callService?.(...args) ?? Promise.reject(new Error('当前传输不支持服务调用')),
    sendTwist: (...args) => active.value.sendTwist(...args),
    sendGoalPose: (...args) => active.value.sendGoalPose(...args),
    sendInitialPose: (...args) => active.value.sendInitialPose(...args),
    findChannelByTopic: (...args) => active.value.findChannelByTopic(...args)
  }
}
