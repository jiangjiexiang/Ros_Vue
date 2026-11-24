<template>
  <div class="robot-manager">
    <header class="robot-manager-header">
      <div>
        <h1>多机器人管理</h1>
        <p>保存不同机器人的连接配置，并切换当前控制对象。</p>
      </div>
      <span>{{ robots.length }} 台机器人</span>
    </header>

    <section class="robot-grid">
      <article v-for="robot in robots" :key="robot.id" class="robot-card" :class="{ active: robot.id === activeRobotId }">
        <div class="robot-card-header">
          <div class="robot-avatar"><UiIcon name="robot" :size="23" /></div>
          <div>
            <h2>{{ robot.name }}</h2>
            <span v-if="robot.id === activeRobotId" class="robot-state" :class="connectionState">
              <i class="status-dot" :class="connectionState"></i>{{ stateText }}
            </span>
            <span v-else>待切换</span>
          </div>
        </div>
        <dl>
          <div><dt>WebSocket</dt><dd>{{ robot.url }}</dd></div>
          <div><dt>命名空间</dt><dd>{{ robot.namespace || '无' }}</dd></div>
        </dl>
        <div class="robot-card-actions">
          <button class="switch-button" :disabled="robot.id === activeRobotId && connectionState === 'connecting'" @click="$emit('switch', robot)">
            {{ robot.id === activeRobotId ? '查看控制台' : '切换并连接' }}
          </button>
          <button class="delete-button" :disabled="robots.length <= 1" @click="remove(robot)">删除</button>
        </div>
      </article>
    </section>

    <section class="add-robot-card">
      <div>
        <h2>添加机器人</h2>
        <p>不同机器人可以使用不同 WebSocket，也可以通过命名空间区分话题。</p>
      </div>
      <form @submit.prevent="add">
        <label>名称<input v-model.trim="form.name" required placeholder="例如：巡检机器人 2"></label>
        <label>WebSocket<input v-model.trim="form.url" required placeholder="ws://192.168.1.20:8765"></label>
        <label>命名空间<input v-model.trim="form.namespace" placeholder="可选，例如 robot2"></label>
        <button type="submit">添加并连接</button>
      </form>
      <p v-if="errorMsg" class="error-message">{{ errorMsg }}</p>
    </section>

    <p class="robot-manager-note">当前为一个活动连接：切换机器人时会断开上一台并清空其地图与遥测，重新连接后显示新机器人的数据。</p>
  </div>
</template>

<script setup>
import { computed, reactive, ref } from 'vue'
import UiIcon from './UiIcon.vue'

const props = defineProps({
  robots: { type: Array, required: true },
  activeRobotId: { type: String, required: true },
  connectionState: { type: String, default: 'disconnected' }
})
const emit = defineEmits(['add', 'remove', 'switch'])
const form = reactive({ name: '', url: 'ws://', namespace: '' })
const errorMsg = ref('')
const stateText = computed(() => ({
  connected: '已连接', connecting: '连接中', error: '连接异常'
}[props.connectionState] || '未连接'))

function add() {
  errorMsg.value = ''
  if (!/^wss?:\/\/.+/.test(form.url)) {
    errorMsg.value = 'WebSocket 地址应以 ws:// 或 wss:// 开头'
    return
  }
  emit('add', {
    name: form.name.trim(),
    url: form.url.trim(),
    namespace: form.namespace.trim().replace(/^\/+|\/+$/g, '')
  })
  form.name = ''
  form.url = 'ws://'
  form.namespace = ''
}

function remove(robot) {
  if (window.confirm(`确定删除机器人“${robot.name}”的配置吗？`)) emit('remove', robot.id)
}
</script>

<style scoped>
.robot-manager { width: min(1180px, 100%); margin: 0 auto; }
.robot-manager-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; }
.robot-manager-header h1 { font-size: 1.2rem; font-weight: 600; }
.robot-manager-header p { margin-top: 7px; color: var(--text-muted); font-size: 0.75rem; }
.robot-manager-header > span { padding: 5px 10px; border: 1px solid var(--border-color); border-radius: 20px; color: var(--text-secondary); font-size: 0.7rem; }
.robot-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(290px, 1fr)); gap: 14px; }
.robot-card { padding: 16px; border: 1px solid var(--border-color); border-radius: var(--radius-lg); background: var(--bg-card); }
.robot-card.active { border-color: rgba(34, 211, 238, 0.35); }
.robot-card-header { display: flex; align-items: center; gap: 12px; }
.robot-avatar { display: grid; place-items: center; width: 44px; height: 44px; border-radius: 11px; color: var(--accent-primary); background: rgba(34, 211, 238, 0.07); }
.robot-card h2 { font-size: 0.9rem; font-weight: 600; }
.robot-card-header span { display: flex; align-items: center; gap: 6px; margin-top: 5px; color: var(--text-muted); font-size: 0.66rem; }
.robot-state.connected { color: var(--success); }
.robot-state.error { color: var(--danger); }
dl { margin: 15px 0; }
dl > div { display: flex; justify-content: space-between; gap: 12px; padding: 7px 0; border-bottom: 1px solid var(--border-color); font-size: 0.67rem; }
dt { color: var(--text-muted); flex: 0 0 auto; }
dd { overflow: hidden; color: var(--text-secondary); font-family: var(--font-mono); text-overflow: ellipsis; white-space: nowrap; }
.robot-card-actions { display: flex; gap: 8px; }
.robot-card-actions button, .add-robot-card button { min-height: 34px; padding: 0 12px; border: 1px solid var(--border-color); border-radius: 7px; color: var(--text-secondary); background: var(--bg-soft); font-size: 0.7rem; cursor: pointer; }
.robot-card-actions .switch-button { flex: 1; color: var(--accent-primary); }
.robot-card-actions .delete-button { color: var(--danger); }
.add-robot-card { margin-top: 20px; padding: 18px; border: 1px solid var(--border-color); border-radius: var(--radius-lg); background: var(--bg-card); }
.add-robot-card h2 { font-size: 0.9rem; }
.add-robot-card p { margin-top: 6px; color: var(--text-muted); font-size: 0.7rem; }
.add-robot-card form { display: grid; grid-template-columns: 1fr 1.5fr 1fr auto; gap: 10px; align-items: end; margin-top: 16px; }
.add-robot-card label { color: var(--text-muted); font-size: 0.65rem; }
.add-robot-card input { display: block; width: 100%; height: 35px; margin-top: 6px; padding: 0 9px; border: 1px solid var(--border-color); border-radius: 7px; color: var(--text-primary); background: var(--bg-secondary); font-size: 0.7rem; }
.add-robot-card .error-message { margin-top: 12px; }
.robot-manager-note { margin-top: 16px; color: var(--text-muted); font-size: 0.68rem; line-height: 1.6; }
@media (max-width: 900px) { .add-robot-card form { grid-template-columns: 1fr; } }
</style>
