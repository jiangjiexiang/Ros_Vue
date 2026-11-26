<template>
  <div class="console-layout" :class="{ 'sidebar-collapsed': sidebarCollapsed }">
    <header class="console-header">
      <div class="header-left">
        <button
          type="button"
          class="sidebar-toggle"
          :title="sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'"
          :aria-label="sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'"
          @click="toggleSidebar"
        >
          <UiIcon name="sidebar" :size="18" />
        </button>

        <RouterLink
          class="brand brand-link"
          to="/overview"
          aria-label="返回总览"
          :aria-current-value="null"
        >
          <div class="brand-mark"><UiIcon name="robot" :size="24" /></div>
          <div>
            <div class="brand-title">QuadPatrol · 四足智巡平台</div>
            <div class="brand-subtitle">{{ activeRobot.name }}</div>
          </div>
        </RouterLink>
      </div>

      <div class="header-context">
        <span class="environment-badge">ROS 2 · HUMBLE</span>
        <span class="header-divider"></span>
        <label class="header-robot-picker">
          <span>当前机器狗</span>
          <select
            :value="activeRobotId"
            class="header-robot-select"
            :disabled="connectionState === 'connecting'"
            aria-label="快速切换当前机器狗"
            @change="onQuickSwitchRobot"
          >
            <option v-for="robot in robots" :key="robot.id" :value="robot.id">
              {{ robot.name }}
            </option>
          </select>
        </label>
        <div class="header-mode">
          <span>当前模式</span>
          <strong>{{ modeText }}</strong>
        </div>
      </div>

      <div class="header-actions">
        <button
          type="button"
          class="header-connection"
          :class="[connectionState, { reconnectable: !isConnected && connectionState !== 'connecting' }]"
          :title="isConnected ? '连接正常' : '点击尝试重连'"
          @click="onConnectionAction"
        >
          <span class="status-dot" :class="connectionState"></span>
          <span>{{ statusText }}</span>
        </button>

        <button
          type="button"
          class="estop-button"
          title="立即下发零速度并清空调度队列"
          @click="emergencyStop"
        >
          <UiIcon name="estop" :size="16" />
          <span>急停</span>
        </button>
      </div>
    </header>

    <div class="console-main">
      <aside class="app-sidebar">
        <nav class="app-nav" aria-label="主导航">
          <template v-for="group in navGroups" :key="group.title">
            <div class="nav-group-label" :aria-hidden="sidebarCollapsed ? 'true' : undefined">
              {{ group.title }}
            </div>
            <RouterLink
              v-for="item in group.items"
              :key="item.id"
              :to="item.to"
              class="app-nav-item"
              :class="{ active: route.meta.nav === item.id }"
              :title="sidebarCollapsed ? item.label : undefined"
              :aria-current="route.meta.nav === item.id ? 'page' : undefined"
            >
              <UiIcon :name="item.icon" :size="18" />
              <span class="nav-item-label">{{ item.label }}</span>
              <span
                v-if="item.badge > 0"
                class="nav-badge"
                :title="`${item.badge} 条未闭环告警`"
              >{{ item.badge > 99 ? '99+' : item.badge }}</span>
            </RouterLink>
          </template>
        </nav>

        <div class="sidebar-status">
          <span class="status-dot" :class="connectionState"></span>
          <div :aria-hidden="sidebarCollapsed ? 'true' : undefined">
            <strong>{{ activeRobot.name }}</strong>
            <span>{{ statusText }}</span>
          </div>
        </div>
      </aside>

      <section class="shell-content" aria-label="页面内容">
        <slot />
      </section>
    </div>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'
import UiIcon from '../components/UiIcon.vue'
import { useRobotStore } from '../stores/robotStore.js'
import { useRosSessionStore } from '../stores/rosSessionStore.js'
import { useInspectionStore } from '../stores/inspectionStore.js'

const SIDEBAR_STORAGE_KEY = 'robot-console-sidebar-collapsed'
const route = useRoute()

const { robots, activeRobotId, activeRobot } = useRobotStore()
const {
  connectionState,
  isConnected,
  modeText,
  statusText,
  switchRobot,
  handleConnect,
  emergencyStop
} = useRosSessionStore()
const { unhandledAlertCount } = useInspectionStore()

const sidebarCollapsed = ref(localStorage.getItem(SIDEBAR_STORAGE_KEY) === 'true')

function toggleSidebar() {
  sidebarCollapsed.value = !sidebarCollapsed.value
  try {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, String(sidebarCollapsed.value))
  } catch {}
}

function onQuickSwitchRobot(event) {
  const target = robots.value.find((robot) => robot.id === event.target.value)
  if (target) switchRobot(target, { reconnect: true })
}

function onConnectionAction() {
  if (!isConnected.value && connectionState.value !== 'connecting') {
    handleConnect(activeRobot.value?.url)
  }
}

const navGroups = computed(() => [
  {
    title: '作业控制',
    items: [
      { id: 'overview', label: '巡检总览', to: '/overview', icon: 'compass' },
      { id: 'inspection', label: '实时工作台', to: '/inspection', icon: 'activity' }
    ]
  },
  {
    title: '巡检业务',
    items: [
      { id: 'missions', label: '巡检任务', to: '/missions', icon: 'route' },
      { id: 'maps', label: '地图场景', to: '/maps', icon: 'map' },
      { id: 'records', label: '巡检记录', to: '/records', icon: 'save' },
      { id: 'alerts', label: '告警中心', to: '/alerts', icon: 'alert', badge: unhandledAlertCount.value }
    ]
  },
  {
    title: '调试与系统',
    items: [
      { id: 'simulation', label: '仿真测试', to: '/simulation', icon: 'cpu' },
      { id: 'robots', label: '机器狗管理', to: '/robots', icon: 'robot' },
      { id: 'settings', label: '系统配置', to: '/settings', icon: 'sliders' }
    ]
  }
])
</script>
