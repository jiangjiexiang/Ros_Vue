<template>
  <section class="control-section map-manager">
    <div class="manager-heading">
      <p class="control-description">已保存 {{ maps.length }} 张地图，可在这里重命名或删除。</p>
      <button class="refresh-button" :disabled="isLoading" title="刷新地图" @click="loadMaps">
        <UiIcon name="refresh" :size="15" :class="{ spinning: isLoading }" />
      </button>
    </div>

    <div v-if="errorMsg" class="error-message">{{ errorMsg }}</div>
    <div v-else-if="isLoading && maps.length === 0" class="empty-text">正在读取地图…</div>
    <div v-else-if="maps.length === 0" class="empty-text">暂无地图，请先在建图页面保存。</div>

    <div v-else class="map-list">
      <article v-for="map in maps" :key="map.path" class="map-row">
        <div v-if="editingName === map.name" class="rename-form">
          <input
            :ref="setEditInput"
            v-model="newName"
            type="text"
            maxlength="80"
            aria-label="新的地图名称"
            :disabled="busy"
            @keydown.enter="renameMap(map.name)"
            @keydown.esc="editingName = ''"
          >
          <div class="map-actions">
            <button :disabled="busy || !newName.trim()" @click="renameMap(map.name)">保存</button>
            <button :disabled="busy" @click="editingName = ''">取消</button>
          </div>
        </div>

        <template v-else>
          <div class="map-row-main">
            <strong>{{ map.name }}</strong>
            <span>{{ formatDate(map.modifiedAt) }} · {{ formatSize(map.size) }}</span>
            <small v-if="!map.hasImage">缺少 PGM 图像文件</small>
          </div>
          <div class="map-actions">
            <button :disabled="busy" @click="editingMap = map.name">编辑</button>
            <button :disabled="busy" @click="$emit('select', map)">导航</button>
            <button :disabled="busy" @click="startRename(map)">重命名</button>
            <button class="delete-button" :disabled="busy" @click="deleteMap(map)">删除</button>
          </div>
        </template>
      </article>
    </div>

    <p class="manager-note">删除前请停止使用该地图的导航任务。切换导航场景后，如导航已运行，请重启导航任务。</p>
    <MapEditor
      v-if="editingMap"
      :mapName="editingMap"
      :maps="maps"
      @close="editingMap = ''"
      @saved="handleSaved"
    />
  </section>
</template>

<script setup>
import { nextTick, onMounted, ref } from 'vue'
import { API_BASE } from '../config.js'
import UiIcon from './UiIcon.vue'
import MapEditor from './MapEditor.vue'

const emit = defineEmits(['changed', 'select'])
const maps = ref([])
const isLoading = ref(false)
const busy = ref(false)
const errorMsg = ref('')
const editingName = ref('')
const newName = ref('')
const editInput = ref(null)
const editingMap = ref('')

async function request(url, options = {}) {
  const res = await fetch(`${API_BASE}${url}`, options)
  const data = await res.json()
  if (!res.ok || data.success === false) throw new Error(data.error || '操作失败')
  return data
}

async function loadMaps() {
  isLoading.value = true
  errorMsg.value = ''
  try {
    const data = await request('/list_maps')
    maps.value = data.maps || []
  } catch (err) {
    errorMsg.value = err.message
  } finally {
    isLoading.value = false
  }
}

function handleSaved(data) {
  maps.value = data.maps
  emit('changed')
}

function startRename(map) {
  editingName.value = map.name
  newName.value = map.name
  nextTick(() => editInput.value?.focus())
}

function setEditInput(element) {
  editInput.value = element
}

async function renameMap(oldName) {
  if (!newName.value.trim()) return
  busy.value = true
  errorMsg.value = ''
  try {
    const data = await request('/rename_map', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oldName, newName: newName.value.trim() })
    })
    maps.value = data.maps
    editingName.value = ''
    emit('changed')
  } catch (err) {
    errorMsg.value = err.message
  } finally {
    busy.value = false
  }
}

async function deleteMap(map) {
  if (!window.confirm(`确定删除地图“${map.name}”吗？此操作不可恢复。`)) return
  busy.value = true
  errorMsg.value = ''
  try {
    const data = await request('/delete_map', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mapName: map.name })
    })
    maps.value = data.maps
    emit('changed')
  } catch (err) {
    errorMsg.value = err.message
  } finally {
    busy.value = false
  }
}

function formatDate(value) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '--' : date.toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  })
}

function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return '--'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

onMounted(loadMaps)
</script>

<style scoped>
.manager-heading { display: flex; align-items: flex-start; gap: 8px; }
.manager-heading .control-description { flex: 1; }
.refresh-button {
  display: grid;
  place-items: center;
  width: 29px;
  height: 29px;
  flex: 0 0 auto;
  border: 1px solid var(--border-color);
  border-radius: 7px;
  color: var(--text-secondary);
  background: var(--bg-soft);
  cursor: pointer;
}
.spinning { animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.map-list { display: flex; flex-direction: column; gap: 8px; max-height: 330px; overflow-y: auto; }
.map-row { padding: 10px; border: 1px solid var(--border-color); border-radius: var(--radius-sm); background: var(--bg-soft); }
.map-row-main { min-width: 0; }
.map-row-main strong { display: block; overflow: hidden; color: var(--text-primary); font-size: 0.75rem; text-overflow: ellipsis; white-space: nowrap; }
.map-row-main span { display: block; margin-top: 6px; color: var(--text-muted); font-size: 0.61rem; }
.map-row-main small { display: block; margin-top: 5px; color: var(--warning); font-size: 0.6rem; }
.map-actions { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 9px; }
.map-actions button {
  min-height: 27px;
  padding: 0 9px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  color: var(--text-secondary);
  background: rgba(148, 163, 184, 0.05);
  font-size: 0.62rem;
  cursor: pointer;
}
.map-actions .delete-button { color: var(--danger); border-color: rgba(251, 113, 133, 0.18); }
.rename-form input { width: 100%; height: 32px; padding: 0 8px; border: 1px solid var(--border-strong); border-radius: 6px; color: var(--text-primary); background: var(--bg-secondary); font-size: 0.7rem; }
.manager-note { margin-top: 11px; color: var(--text-muted); font-size: 0.62rem; line-height: 1.5; }
</style>
