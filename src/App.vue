<template>
  <div class="console-layout">
    <!-- 顶部导航栏 -->
    <header class="console-header">
      <h1><span class="emoji">🤖</span> 机器人中控台</h1>
      <div class="status-indicator">
        <span class="status-dot" :class="connectionState"></span>
        <span>{{ statusText }}</span>
      </div>
    </header>

    <!-- 主体三栏布局 -->
    <main class="console-body">
      <!-- 左栏: 摇杆 -->
      <section class="left-panel">
        <JoystickControl
          :connected="isConnected"
          @velocity-change="onVelocityChange"
        />
      </section>

      <!-- 中栏: 地图 -->
      <section class="center-panel">
        <SlamMap
          :connected="isConnected"
          :mapData="mapData"
          :scanData="scanData"
          :tfData="tfData"
        />
      </section>

      <!-- 右栏: 连接 + 电量 + 话题 -->
      <section class="right-panel">
        <ConnectionPanel
          :connectionState="connectionState"
          :serverName="serverName"
          :errorMessage="errorMessage"
          @connect="handleConnect"
          @disconnect="handleDisconnect"
        />

        <BatteryStatus
          :percentage="batteryPercentage"
          :voltage="batteryVoltage"
          :connected="isConnected"
        />

        <div class="card" v-if="isConnected && topics.length > 0">
          <div class="card-header">
            <span class="icon">📡</span> 可用话题
          </div>
          <div class="card-body">
            <ul class="topic-list">
              <li class="topic-item" v-for="t in topics" :key="t.id">
                <span class="dot"></span>
                {{ t.topic }}
              </li>
            </ul>
          </div>
        </div>
      </section>
    </main>
  </div>
</template>

<script setup>
import { ref, computed, onUnmounted } from 'vue'
import { useFoxglove } from './composables/useFoxglove.js'
import JoystickControl from './components/JoystickControl.vue'
import BatteryStatus from './components/BatteryStatus.vue'
import SlamMap from './components/SlamMap.vue'
import ConnectionPanel from './components/ConnectionPanel.vue'

const foxglove = useFoxglove()

// ---- 状态 ----
const topics = ref([])
const batteryPercentage = ref(-1)
const batteryVoltage = ref(0)
const mapData = ref(null)
const scanData = ref(null)
const tfData = ref(null)
let cmdVelChannelId = null
let batterySubId = null
let mapSubId = null
let scanSubId = null
let tfSubId = null

// ---- 计算属性 ----
const connectionState = computed(() => foxglove.connectionState.value)
const serverName = computed(() => foxglove.serverName.value)
const errorMessage = computed(() => foxglove.errorMessage.value)
const isConnected = computed(() => connectionState.value === 'connected')

const statusText = computed(() => {
  switch (connectionState.value) {
    case 'connected': return `已连接 — ${foxglove.serverName.value}`
    case 'connecting': return '连接中...'
    case 'error': return '连接错误'
    default: return '未连接'
  }
})

// ---- 事件处理 ----
function handleConnect(url) {
  foxglove.connect(url)
}

function handleDisconnect() {
  foxglove.disconnect()
  cmdVelChannelId = null
  batterySubId = null
  mapSubId = null
  batteryPercentage.value = -1
  batteryVoltage.value = 0
  mapData.value = null
  scanData.value = null
  tfData.value = null
  topics.value = []
}

/**
 * 当服务器广播可用频道后，自动:
 * 1. Advertise /cmd_vel (用于发布摇杆指令)
 * 2. Subscribe /battery_state (电量)
 * 3. Subscribe /map (SLAM 地图)
 */
function onChannelsReady(event) {
  const channels = event.detail
  topics.value = channels

  // 1. 声明 /cmd_vel 发布频道
  if (!cmdVelChannelId) {
    cmdVelChannelId = foxglove.clientAdvertise('/cmd_vel', 'geometry_msgs/Twist', 'json')
  }

  // 2. 订阅 /battery (电压值，单位可能是 0.1V)
  if (!batterySubId) {
    batterySubId = foxglove.subscribe('/battery', (data) => {
      // std_msgs/msg/UInt16 → data 字段
      if (data.data !== undefined) {
        batteryVoltage.value = (data.data / 10).toFixed(1)
        
        // 自动推算百分比 (根据常见的 2S 或 3S 锂电池范围)
        const raw = data.data
        if (raw > 90) { // 可能是 3S (9.6V - 12.6V)
          batteryPercentage.value = Math.max(0, Math.min(100, Math.round((raw - 96) / (126 - 96) * 100)))
        } else { // 可能是 2S (6.4V - 8.4V)
          batteryPercentage.value = Math.max(0, Math.min(100, Math.round((raw - 64) / (84 - 64) * 100)))
        }
      }
    })
  }

  // 3. 订阅 /map
  if (!mapSubId) {
    mapSubId = foxglove.subscribe('/map', (data) => {
      mapData.value = data
    })
  }

  // 4. 订阅 /scan
  if (!scanSubId) {
    scanSubId = foxglove.subscribe('/scan', (data) => {
      scanData.value = data
    })
  }

  // 5. 订阅 /tf
  if (!tfSubId) {
    tfSubId = foxglove.subscribe('/tf', (data) => {
      tfData.value = data
    })
  }
}

// 监听频道就绪事件
window.addEventListener('foxglove:channels', onChannelsReady)
onUnmounted(() => {
  window.removeEventListener('foxglove:channels', onChannelsReady)
  foxglove.disconnect()
})

// ---- 摇杆速度变化 → 发送 Twist ----
function onVelocityChange({ linearX, angularZ }) {
  if (cmdVelChannelId && isConnected.value) {
    foxglove.sendTwist(cmdVelChannelId, linearX, angularZ)
  }
}
</script>
