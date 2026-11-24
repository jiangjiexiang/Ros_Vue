<template>
  <div class="console-layout">
    <header class="console-header">
      <RouterLink
        class="brand brand-link"
        to="/overview"
        aria-label="返回总览"
        :aria-current-value="null"
      >
        <div class="brand-mark"><UiIcon name="robot" :size="25" /></div>
        <div>
          <div class="brand-title">四足巡检平台</div>
          <div class="brand-subtitle">{{ robotName }}</div>
        </div>
      </RouterLink>

      <div class="header-context">
        <span class="environment-badge">ROS 2 · HUMBLE</span>
        <span class="header-divider"></span>
        <div class="header-mode">
          <span>当前机器狗</span>
          <strong>{{ robotName }}</strong>
        </div>
        <div class="header-mode">
          <span>当前模式</span>
          <strong>{{ modeText }}</strong>
        </div>
      </div>

      <div class="header-connection" :class="connectionState" role="status">
        <span class="status-dot" :class="connectionState"></span>
        <span>{{ statusText }}</span>
      </div>
    </header>

    <aside class="app-sidebar">
      <nav class="app-nav" aria-label="主导航">
        <RouterLink
          v-for="item in navItems"
          :key="item.id"
          :to="item.to"
          class="app-nav-item"
          :class="{ active: route.meta.nav === item.id }"
          :aria-current="route.meta.nav === item.id ? 'page' : undefined"
        >
          <svg
            v-if="item.icon === 'alert'"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
            <path d="M10 21h4" />
          </svg>
          <UiIcon v-else :name="item.icon" :size="18" />
          <span>{{ item.label }}</span>
        </RouterLink>
      </nav>

      <div class="sidebar-status">
        <span class="status-dot" :class="connectionState"></span>
        <div>
          <strong>{{ robotName }}</strong>
          <span>{{ statusText }}</span>
        </div>
      </div>
    </aside>

    <section class="shell-content" aria-label="页面内容">
      <slot />
    </section>
  </div>
</template>

<script setup>
import { useRoute } from 'vue-router'
import UiIcon from '../components/UiIcon.vue'

defineProps({
  robotName: {
    type: String,
    required: true
  },
  modeText: {
    type: String,
    required: true
  },
  connectionState: {
    type: String,
    required: true
  },
  statusText: {
    type: String,
    required: true
  }
})

const route = useRoute()
const navItems = [
  { id: 'overview', label: '总览', to: '/overview', icon: 'compass' },
  { id: 'inspection', label: '巡检工作台', to: '/inspection', icon: 'activity' },
  { id: 'monitor', label: '单机监控', to: '/monitor', icon: 'robot' },
  { id: 'missions', label: '巡检任务', to: '/missions', icon: 'route' },
  { id: 'maps', label: '地图场景', to: '/maps', icon: 'map' },
  { id: 'records', label: '巡检记录', to: '/records', icon: 'save' },
  { id: 'alerts', label: '告警中心', to: '/alerts', icon: 'alert' },
  { id: 'robots', label: '机器狗管理', to: '/robots', icon: 'robot' },
  { id: 'settings', label: '系统配置', to: '/settings', icon: 'layers' }
]
</script>
