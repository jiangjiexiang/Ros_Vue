<template>
  <section class="card camera-panel">
    <div class="card-header camera-header">
      <span class="camera-title">
        <i class="camera-icon" aria-hidden="true"></i>
        {{ title }}
      </span>
      <span class="live-badge" :class="{ active: hasImage }">
        <i></i>LIVE
      </span>
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
  </section>
</template>

<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'

const props = defineProps({
  title: { type: String, default: '巡检相机' },
  message: { type: Object, default: null },
  connected: { type: Boolean, default: false },
  topic: { type: String, default: '' }
})

const imageSrc = ref('')
const imageError = ref(false)
let objectUrl = ''

const normalizedFormat = computed(() => String(props.message?.format || '').trim().toLowerCase())
const mimeType = computed(() => ({
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png'
}[normalizedFormat.value] || ''))
const formatLabel = computed(() => normalizedFormat.value ? normalizedFormat.value.toUpperCase() : '--')
const hasImage = computed(() => props.connected && !!imageSrc.value && !imageError.value)

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
  if (!props.connected || !mimeType.value) return

  const data = props.message?.data
  if (typeof data === 'string') {
    const value = data.trim()
    if (!value) return
    imageSrc.value = /^data:image\//i.test(value)
      ? value
      : `data:${mimeType.value};base64,${value}`
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
}

watch(
  [() => props.message?.data, () => props.message?.format, () => props.connected],
  refreshImage,
  { immediate: true }
)

onBeforeUnmount(clearImage)
</script>

<style scoped>
.camera-panel {
  flex: 0 0 auto;
}
.camera-header {
  min-height: 40px;
  padding: 0 12px;
  font-size: 0.72rem;
}
.camera-title {
  min-width: 0;
}
.camera-icon {
  width: 14px;
  height: 11px;
  border: 1.5px solid var(--accent-primary);
  border-radius: 3px;
  position: relative;
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
  font-size: 0.56rem;
  letter-spacing: 0.08em;
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
  box-shadow: 0 0 0 3px rgba(251, 113, 133, 0.1);
}
.camera-frame {
  position: relative;
  aspect-ratio: 16 / 9;
  min-height: 118px;
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
  font-size: 0.7rem;
  font-weight: 550;
}
.camera-placeholder p {
  max-width: 100%;
  margin-top: 5px;
  overflow: hidden;
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: 0.56rem;
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
  min-height: 31px;
  padding: 0 11px;
  border-top: 1px solid var(--border-color);
}
.format-badge {
  flex: 0 0 auto;
  padding: 2px 5px;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  color: var(--text-secondary);
  background: var(--bg-soft);
  font-family: var(--font-mono);
  font-size: 0.52rem;
}
.camera-topic {
  min-width: 0;
  overflow: hidden;
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: 0.55rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
