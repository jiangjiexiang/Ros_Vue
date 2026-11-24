<template>
  <main class="settings-page">
    <div class="settings-diag-bar">
      <div class="diag-pills">
        <span class="diag-pill" :class="{ ok: diagnostics.workspaceExists }">
          <i></i>ROS 工作空间{{ diagnostics.workspaceExists ? '就绪' : '未找到' }}
        </span>
        <span class="diag-pill" :class="{ ok: diagnostics.setupBashExists }">
          <i></i>setup.bash {{ diagnostics.setupBashExists ? '存在' : '缺失' }}
        </span>
        <span class="diag-pill" :class="{ ok: diagnostics.mapsDirExists }">
          <i></i>地图目录{{ diagnostics.mapsDirExists ? '就绪' : '待创建' }}
        </span>
      </div>
      <button
        type="button"
        class="btn btn-secondary reconnect-btn"
        :disabled="connectionState === 'connecting'"
        @click="reconnectRobot"
      >
        <UiIcon name="refresh" :size="15" />
        <span>重连当前机器狗（{{ activeRobot.name }}）</span>
      </button>
    </div>

    <RuntimeSettings @saved="handleSaved" />
  </main>
</template>

<script setup>
import { nextTick } from 'vue'
import RuntimeSettings from '../components/RuntimeSettings.vue'
import UiIcon from '../components/UiIcon.vue'
import { useRobotStore } from '../stores/robotStore.js'
import { useRuntimeConfigStore } from '../stores/runtimeConfigStore.js'
import { useRosSessionStore } from '../stores/rosSessionStore.js'
import { showToast } from '../stores/toastStore.js'

const { activeRobot } = useRobotStore()
const { diagnostics, loadRuntimeConfig } = useRuntimeConfigStore()
const { connectionState, handleDisconnect, handleConnect } = useRosSessionStore()

async function handleSaved() {
  await loadRuntimeConfig()
  showToast('ROS 运行配置已保存', 'success')
}

function reconnectRobot() {
  handleDisconnect()
  nextTick(() => handleConnect(activeRobot.value?.url))
  showToast(`正在重连「${activeRobot.value.name}」`, 'info')
}
</script>

<style scoped>
.settings-diag-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
  width: min(1100px, 100%);
  margin: 0 auto 16px;
  padding: 12px 16px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: var(--bg-card);
}

.diag-pills {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.diag-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border: 1px solid var(--border-color);
  border-radius: 999px;
  color: var(--text-muted);
  background: var(--bg-soft);
  font-size: var(--text-xs);
}

.diag-pill i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--warning);
}

.diag-pill.ok {
  border-color: rgba(52, 211, 153, 0.25);
  color: var(--success);
}

.diag-pill.ok i {
  background: var(--success);
}

.reconnect-btn {
  min-height: 34px;
  font-size: var(--text-xs);
}
</style>
