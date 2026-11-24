import { computed } from 'vue'
import { useFoxglove } from './useFoxglove.js'
import { useRosbridge } from './useRosbridge.js'

export function useRosTransport() {
  const foxglove = useFoxglove()
  const rosbridge = useRosbridge()
  let active = foxglove

  const connectionState = computed(() => active.connectionState.value)
  const errorMessage = computed(() => active.errorMessage.value)
  const serverName = computed(() => active.serverName.value)
  const serverCapabilities = computed(() => active.serverCapabilities.value)

  function connect(url, protocol = 'foxglove') {
    const next = protocol === 'rosbridge' ? rosbridge : foxglove
    if (active !== next) active.disconnect()
    active = next
    active.connect(url)
  }

  function disconnect() {
    active.disconnect()
  }

  return {
    connectionState,
    errorMessage,
    serverName,
    serverCapabilities,
    get availableChannels() { return active.availableChannels },
    connect,
    disconnect,
    subscribe: (...args) => active.subscribe(...args),
    unsubscribe: (...args) => active.unsubscribe(...args),
    clientAdvertise: (...args) => active.clientAdvertise(...args),
    publishMessage: (...args) => active.publishMessage(...args),
    sendTwist: (...args) => active.sendTwist(...args),
    sendGoalPose: (...args) => active.sendGoalPose(...args),
    sendInitialPose: (...args) => active.sendInitialPose(...args),
    findChannelByTopic: (...args) => active.findChannelByTopic(...args)
  }
}
