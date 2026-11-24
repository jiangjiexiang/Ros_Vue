import { computed, shallowRef } from 'vue'
import { useFoxglove } from './useFoxglove.js'
import { useRosbridge } from './useRosbridge.js'

export function useRosTransport() {
  const foxglove = useFoxglove()
  const rosbridge = useRosbridge()
  const active = shallowRef(foxglove)

  const connectionState = computed(() => active.value.connectionState.value)
  const errorMessage = computed(() => active.value.errorMessage.value)
  const serverName = computed(() => active.value.serverName.value)
  const serverCapabilities = computed(() => active.value.serverCapabilities.value)
  const protocol = computed(() => (active.value === rosbridge ? 'rosbridge' : 'foxglove'))

  function connect(url, targetProtocol = 'foxglove') {
    const next = targetProtocol === 'rosbridge' ? rosbridge : foxglove
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
    protocol,
    get availableChannels() { return active.value.availableChannels },
    connect,
    disconnect,
    subscribe: (...args) => active.value.subscribe(...args),
    unsubscribe: (...args) => active.value.unsubscribe(...args),
    clientAdvertise: (...args) => active.value.clientAdvertise(...args),
    publishMessage: (...args) => active.value.publishMessage(...args),
    sendTwist: (...args) => active.value.sendTwist(...args),
    sendGoalPose: (...args) => active.value.sendGoalPose(...args),
    sendInitialPose: (...args) => active.value.sendInitialPose(...args),
    findChannelByTopic: (...args) => active.value.findChannelByTopic(...args)
  }
}
