<template>
  <section class="control-section map-manager">
    <div class="manager-heading">
      <p class="control-description">已保存 {{ maps.length }} 张地图，支持缩略图预览、栅格编辑、重命名与一键导航。</p>
      <button class="refresh-button" :disabled="isLoading" title="刷新地图" @click="loadMaps">
        <UiIcon name="refresh" :size="15" :class="{ spinning: isLoading }" />
      </button>
    </div>

    <div v-if="errorMsg" class="error-message">{{ errorMsg }}</div>
    <div v-else-if="isLoading && maps.length === 0" class="empty-text">正在读取地图…</div>
    <div v-else-if="maps.length === 0" class="empty-text">暂无地图，请先在建图页面保存。</div>

    <div v-else class="map-list">
      <article v-for="map in maps" :key="map.path" class="map-row">
        <div class="map-thumb">
          <img v-if="previews[map.name]?.url" :src="previews[map.name].url" :alt="`${map.name} 地图预览`">
          <div v-else class="thumb-placeholder">
            <UiIcon name="map" :size="22" />
            <span>{{ map.hasImage ? '预览加载中' : '缺少 PGM' }}</span>
          </div>
          <span v-if="previews[map.name]?.meta" class="thumb-meta">{{ previews[map.name].meta }}</span>
        </div>

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
            <button :disabled="busy" @click="editingMap = map.name">编辑栅格</button>
            <button class="nav-button" :disabled="busy" @click="$emit('select', map)">用于导航</button>
            <button :disabled="busy" @click="startRename(map)">重命名</button>
            <button class="delete-button" :disabled="busy" @click="deleteMap(map)">删除</button>
          </div>
        </template>
      </article>
    </div>

    <p class="manager-note">删除前请停止使用该地图的导航任务。编辑或切换场景后，如导航已运行请重启导航任务。</p>
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
import { nextTick, onMounted, reactive, ref } from 'vue'
import { API_BASE, apiFetch } from '../config.js'
import { confirmDialog, showToast } from '../stores/toastStore.js'
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
const previews = reactive({})

async function request(url, options = {}) {
  const res = await apiFetch(`${API_BASE}${url}`, options)
  const data = await res.json()
  if (!res.ok || data.success === false) throw new Error(data.error || '操作失败')
  return data
}

function buildThumbnailUrl(width, height, base64Pixels) {
  const binary = atob(base64Pixels)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  const img = ctx.createImageData(width, height)
  for (let i = 0; i < width * height && i < binary.length; i++) {
    const val = binary.charCodeAt(i)
    const color = val === 205 ? [72, 84, 102] : [val, val, val]
    img.data[i * 4] = color[0]
    img.data[i * 4 + 1] = color[1]
    img.data[i * 4 + 2] = color[2]
    img.data[i * 4 + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  return canvas.toDataURL('image/png')
}

async function loadThumbnails(list) {
  for (const map of list) {
    if (!map.hasImage) continue
    try {
      const data = await request(`/maps/${encodeURIComponent(map.name)}/content`)
      if (data.width && data.height && data.pixels) {
        previews[map.name] = {
          url: buildThumbnailUrl(data.width, data.height, data.pixels),
          meta: `${data.width}×${data.height} · ${data.resolution || 0.05}m`
        }
      }
    } catch {}
  }
}

async function loadMaps() {
  isLoading.value = true
  errorMsg.value = ''
  try {
    const data = await request('/list_maps')
    maps.value = data.maps || []
    loadThumbnails(maps.value)
  } catch (err) {
    errorMsg.value = err.message
  } finally {
    isLoading.value = false
  }
}

function handleSaved(data) {
  maps.value = data.maps
  loadThumbnails(maps.value)
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
    delete previews[oldName]
    maps.value = data.maps
    editingName.value = ''
    loadThumbnails(maps.value)
    showToast(`已重命名为“${newName.value.trim()}”`, 'success')
    emit('changed')
  } catch (err) {
    errorMsg.value = err.message
  } finally {
    busy.value = false
  }
}

async function deleteMap(map) {
  const ok = await confirmDialog({
    title: '删除地图场景',
    message: `确定删除地图“${map.name}”吗？YAML 与 PGM 文件将被移除且不可恢复。`,
    confirmText: '确认删除',
    danger: true
  })
  if (!ok) return
  busy.value = true
  errorMsg.value = ''
  try {
    const data = await request('/delete_map', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mapName: map.name })
    })
    delete previews[map.name]
    maps.value = data.maps
    showToast(`已删除地图“${map.name}”`, 'info')
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
.manager-heading .control-description { flex: 1; font-size: var(--text-sm); }
.refresh-button {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  flex: 0 0 auto;
  border: 1px solid var(--border-color);
  border-radius: 7px;
  color: var(--text-secondary);
  background: var(--bg-soft);
  cursor: pointer;
}
.spinning { animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.map-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; }
.map-row {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: var(--bg-soft);
}
.map-thumb {
  position: relative;
  display: grid;
  place-items: center;
  height: 132px;
  overflow: hidden;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: #050c16;
}
.map-thumb img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  image-rendering: pixelated;
}
.thumb-placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  color: var(--text-muted);
  font-size: var(--text-xs);
}
.thumb-meta {
  position: absolute;
  right: 6px;
  bottom: 6px;
  padding: 2px 6px;
  border-radius: 4px;
  color: var(--text-secondary);
  background: rgba(5, 12, 22, 0.82);
  font-family: var(--font-mono);
  font-size: 0.68rem;
}
.map-row-main { min-width: 0; }
.map-row-main strong { display: block; overflow: hidden; color: var(--text-primary); font-size: var(--text-base); text-overflow: ellipsis; white-space: nowrap; }
.map-row-main span { display: block; margin-top: 5px; color: var(--text-muted); font-size: var(--text-xs); }
.map-row-main small { display: block; margin-top: 4px; color: var(--warning); font-size: var(--text-xs); }
.map-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: auto; }
.map-actions button {
  min-height: 30px;
  padding: 0 10px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  color: var(--text-secondary);
  background: rgba(148, 163, 184, 0.06);
  font-size: var(--text-xs);
  cursor: pointer;
}
.map-actions .nav-button { color: var(--accent-primary); border-color: rgba(34, 211, 238, 0.25); }
.map-actions .delete-button { color: var(--danger); border-color: rgba(251, 113, 133, 0.22); }
.rename-form input { width: 100%; height: 34px; margin-bottom: 8px; padding: 0 9px; border: 1px solid var(--border-strong); border-radius: 6px; color: var(--text-primary); background: var(--bg-secondary); font-size: var(--text-sm); }
.manager-note { margin-top: 14px; color: var(--text-muted); font-size: var(--text-xs); line-height: 1.5; }
</style>
