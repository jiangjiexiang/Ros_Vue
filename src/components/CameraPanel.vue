<template>
  <section class="card camera-panel">
    <div class="card-header camera-header">
      <span class="camera-title">
        <i class="camera-icon" aria-hidden="true"></i>
        {{ title }}
      </span>
      <div class="camera-header-right">
        <span class="live-badge" :class="{ active: hasImage }">
          <i></i>{{ hasImage ? (fpsLabel ? `LIVE · ${fpsLabel}` : 'LIVE') : 'OFFLINE' }}
        </span>
        <button
          type="button"
          class="cam-tool-btn"
          :disabled="!hasImage"
          title="抓拍当前帧"
          aria-label="抓拍当前帧"
          @click="captureSnapshot"
        >
          <UiIcon name="camera" :size="13" />
        </button>
        <button
          type="button"
          class="cam-tool-btn"
          :disabled="!hasImage"
          title="放大预览"
          aria-label="放大预览"
          @click="lightboxOpen = true"
        >
          <UiIcon name="compass" :size="13" />
        </button>
      </div>
    </div>

    <div class="camera-frame">
      <img
        v-if="hasImage"
        :src="imageSrc"
        :alt="`${title}实时画面`"
        @load="imageError = false"
        @error="imageError = true"
      >
      <div v-else class="camera-placeholder">
        <span class="placeholder-mark" aria-hidden="true"></span>
        <strong>{{ placeholderTitle }}</strong>
        <p>{{ placeholderText }}</p>
      </div>
      <span class="frame-corner corner-tl"></span>
      <span class="frame-corner corner-tr"></span>
      <span class="frame-corner corner-bl"></span>
      <span class="frame-corner corner-br"></span>
    </div>

    <div class="camera-meta">
      <span class="format-badge">{{ formatLabel }}</span>
      <span class="camera-topic" :title="topic">{{ topic || '未配置话题' }}</span>
    </div>

    <Teleport to="body">
      <div
        v-if="lightboxOpen"
        class="camera-lightbox"
        role="dialog"
        aria-modal="true"
        :aria-label="`${title}放大预览`"
        @click.self="lightboxOpen = false"
      >
        <div class="lightbox-card">
          <header class="lightbox-header">
            <div>
              <strong>{{ title }}</strong>
              <span>{{ topic || '实时视频流' }}</span>
            </div>
            <div class="lightbox-actions">
              <button type="button" class="btn btn-secondary" :disabled="!hasImage" @click="captureSnapshot">
                <UiIcon name="camera" :size="15" />抓拍保存
              </button>
              <button type="button" class="lightbox-close" aria-label="关闭预览" @click="lightboxOpen = false">
                <UiIcon name="x" :size="18" />
              </button>
            </div>
          </header>
          <div class="lightbox-stage">
            <img v-if="hasImage" :src="imageSrc" :alt="`${title}放大画面`">
            <p v-else>暂无有效视频帧</p>
          </div>
        </div>
      </div>
    </Teleport>
  </section>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import UiIcon from './UiIcon.vue'
import { showToast } from '../stores/toastStore.js'

const props = defineProps({
  title: { type: String, default: '巡检相机' },
  message: { type: Object, default: null },
  connected: { type: Boolean, default: false },
  topic: { type: String, default: '' }
})

const imageSrc = ref('')
const imageError = ref(false)
const lightboxOpen = ref(false)
const fpsValue = ref(0)
let objectUrl = ''
const frameTimestamps = []

const normalizedFormat = computed(() => String(props.message?.format || '').trim().toLowerCase())
const mimeType = computed(() => ({
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png'
}[normalizedFormat.value] || ''))
const formatLabel = computed(() => normalizedFormat.value ? normalizedFormat.value.toUpperCase() : '--')
const hasImage = computed(() => props.connected && !!imageSrc.value && !imageError.value)
const fpsLabel = computed(() => (fpsValue.value > 0 ? `${fpsValue.value.toFixed(1)} FPS` : ''))

const placeholderTitle = computed(() => {
  if (!props.connected) return '相机未连接'
  if (imageError.value) return '图像解码失败'
  if (props.message && !mimeType.value) return '不支持的图像格式'
  return '等待图像数据'
})
const placeholderText = computed(() => {
  if (!props.connected) return '连接机器人后接收实时画面'
  if (imageError.value) return '正在等待下一帧有效图像'
  if (props.message && !mimeType.value) return '仅支持 JPEG / JPG / PNG'
  return props.topic || '等待压缩图像话题'
})

function updateFps() {
  const now = performance.now()
  frameTimestamps.push(now)
  while (frameTimestamps.length > 12 || (frameTimestamps.length > 2 && now - frameTimestamps[0] > 3000)) {
    frameTimestamps.shift()
  }
  if (frameTimestamps.length >= 2) {
    const span = frameTimestamps[frameTimestamps.length - 1] - frameTimestamps[0]
    fpsValue.value = span > 0 ? ((frameTimestamps.length - 1) * 1000) / span : 0
  } else {
    fpsValue.value = 0
  }
}

function clearImage() {
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl)
    objectUrl = ''
  }
  imageSrc.value = ''
  imageError.value = false
}

function refreshImage() {
  clearImage()
  if (!props.connected || !mimeType.value) {
    frameTimestamps.length = 0
    fpsValue.value = 0
    return
  }

  const data = props.message?.data
  if (typeof data === 'string') {
    const value = data.trim()
    if (!value) return
    imageSrc.value = /^data:image\//i.test(value)
      ? value
      : `data:${mimeType.value};base64,${value}`
    updateFps()
    return
  }

  if (!Array.isArray(data) && !ArrayBuffer.isView(data) && !(data instanceof ArrayBuffer)) return
  const bytes = data instanceof ArrayBuffer
    ? new Uint8Array(data)
    : ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data)
  if (!bytes.byteLength) return

  objectUrl = URL.createObjectURL(new Blob([bytes], { type: mimeType.value }))
  imageSrc.value = objectUrl
  updateFps()
}

function captureSnapshot() {
  if (!hasImage.value) return
  const ext = normalizedFormat.value === 'png' ? 'png' : 'jpg'
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const link = document.createElement('a')
  link.href = imageSrc.value
  link.download = `camera-${stamp}.${ext}`
  document.body.appendChild(link)
  link.click()
  link.remove()
  showToast('已保存当前帧抓拍图像', 'success')
}

function onKeyDown(e) {
  if (lightboxOpen.value && e.key === 'Escape') {
    lightboxOpen.value = false
  }
}

watch(
  [() => props.message?.data, () => props.message?.format, () => props.connected],
  refreshImage,
  { immediate: true }
)

onMounted(() => window.addEventListener('keydown', onKeyDown))

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeyDown)
  clearImage()
})
</script>

<style scoped>
.camera-panel {
  flex: 0 0 auto;
}
.camera-header {
  min-height: 40px;
  padding: 0 12px;
  font-size: var(--text-xs);
  gap: 8px;
}
.camera-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.camera-header-right {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
}
.cam-tool-btn {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  color: var(--text-secondary);
  background: var(--bg-soft);
  cursor: pointer;
}
.cam-tool-btn:hover:not(:disabled) {
  border-color: var(--accent-primary);
  color: var(--accent-primary);
}
.camera-icon {
  width: 14px;
  height: 11px;
  border: 1.5px solid var(--accent-primary);
  border-radius: 3px;
  position: relative;
  flex: 0 0 auto;
}
.camera-icon::after {
  content: '';
  position: absolute;
  top: 1px;
  right: -5px;
  width: 4px;
  height: 7px;
  border: 1.5px solid var(--accent-primary);
  border-left: 0;
  border-radius: 0 2px 2px 0;
}
.live-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: 0.68rem;
  letter-spacing: 0.04em;
}
.live-badge i {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
}
.live-badge.active {
  color: var(--danger);
}
.live-badge.active i {
  box-shadow: 0 0 0 3px rgba(251, 113, 133, 0.14);
}
.camera-frame {
  position: relative;
  aspect-ratio: 16 / 9;
  min-height: 120px;
  overflow: hidden;
  background:
    linear-gradient(rgba(148, 163, 184, 0.025) 1px, transparent 1px),
    linear-gradient(90deg, rgba(148, 163, 184, 0.025) 1px, transparent 1px),
    #050c16;
  background-size: 24px 24px;
}
.camera-frame img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.camera-placeholder {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 14px;
  text-align: center;
}
.placeholder-mark {
  width: 24px;
  height: 24px;
  margin-bottom: 9px;
  border: 1px solid rgba(100, 116, 139, 0.45);
  border-radius: 7px;
  background: linear-gradient(135deg, transparent 45%, rgba(100, 116, 139, 0.4) 46%, rgba(100, 116, 139, 0.4) 52%, transparent 53%);
}
.camera-placeholder strong {
  color: var(--text-secondary);
  font-size: var(--text-xs);
  font-weight: 550;
}
.camera-placeholder p {
  max-width: 100%;
  margin-top: 5px;
  overflow: hidden;
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: 0.7rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.frame-corner {
  position: absolute;
  width: 10px;
  height: 10px;
  border-color: rgba(34, 211, 238, 0.35);
  border-style: solid;
  pointer-events: none;
}
.corner-tl { top: 8px; left: 8px; border-width: 1px 0 0 1px; }
.corner-tr { top: 8px; right: 8px; border-width: 1px 1px 0 0; }
.corner-bl { bottom: 8px; left: 8px; border-width: 0 0 1px 1px; }
.corner-br { right: 8px; bottom: 8px; border-width: 0 1px 1px 0; }
.camera-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 32px;
  padding: 0 11px;
  border-top: 1px solid var(--border-color);
}
.format-badge {
  flex: 0 0 auto;
  padding: 2px 6px;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  color: var(--text-secondary);
  background: var(--bg-soft);
  font-family: var(--font-mono);
  font-size: 0.68rem;
}
.camera-topic {
  min-width: 0;
  overflow: hidden;
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: 0.72rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.camera-lightbox {
  position: fixed;
  inset: 0;
  z-index: 120;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgba(2, 8, 18, 0.84);
  backdrop-filter: blur(8px);
}
.lightbox-card {
  display: flex;
  flex-direction: column;
  width: min(960px, 100%);
  max-height: 90vh;
  overflow: hidden;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-lg);
  background: var(--bg-card);
}
.lightbox-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 14px 18px;
  border-bottom: 1px solid var(--border-color);
}
.lightbox-header strong {
  display: block;
  font-size: 0.96rem;
}
.lightbox-header span {
  display: block;
  margin-top: 3px;
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}
.lightbox-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}
.lightbox-close {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  color: var(--text-secondary);
  background: var(--bg-soft);
  cursor: pointer;
}
.lightbox-stage {
  display: grid;
  place-items: center;
  min-height: 340px;
  padding: 16px;
  background: #040a12;
}
.lightbox-stage img {
  max-width: 100%;
  max-height: 74vh;
  object-fit: contain;
}
</style>
