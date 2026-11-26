<template>
  <main class="robots-page">
    <RobotManager
      :robots="robots"
      :activeRobotId="activeRobotId"
      :connectionState="connectionState"
      :on-add="handleAdd"
      :on-update="handleUpdate"
      :on-remove="handleRemove"
      @switch="handleSwitch"
    />
  </main>
</template>

<script setup>
import { nextTick } from 'vue'
import { useRouter } from 'vue-router'
import RobotManager from '../components/RobotManager.vue'
import { useRobotStore } from '../stores/robotStore.js'
import { useRosSessionStore } from '../stores/rosSessionStore.js'
import { showToast } from '../stores/toastStore.js'

const router = useRouter()
const { robots, activeRobotId, activeRobot, addRobot, updateRobot, removeRobot } = useRobotStore()
const { connectionState, isConnected, switchRobot, handleDisconnect, handleConnect } = useRosSessionStore()

async function handleAdd(config) {
  const created = await addRobot(config)
  switchRobot(created, { reconnect: true })
  showToast(`已添加机器狗「${created.name}」并尝试连接`, 'success')
  router.push('/inspection')
  return created
}

async function handleUpdate(config) {
  const updated = await updateRobot(config)
  if (updated.id === activeRobotId.value && isConnected.value) {
    handleDisconnect()
    nextTick(() => handleConnect(updated.url))
  }
  showToast(`已更新「${updated.name}」配置`, 'success')
  return updated
}

async function handleRemove(id) {
  const target = robots.value.find((robot) => robot.id === id)
  const wasActive = id === activeRobotId.value
  const removed = await removeRobot(id)
  if (!removed) throw new Error('机器狗配置未删除，请保留至少一台机器狗')
  if (wasActive) {
    handleDisconnect()
    nextTick(() => handleConnect(activeRobot.value?.url))
  }
  showToast(`已删除「${target?.name || '机器狗'}」`, 'info')
  return true
}

function handleSwitch(robot) {
  switchRobot(robot, { reconnect: true })
  router.push('/inspection')
}
</script>
