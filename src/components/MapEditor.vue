<template>
  <Teleport to="body">
    <div class="editor-overlay">
      <section class="map-editor">
        <header class="editor-header">
          <div>
            <h2>地图编辑器</h2>
            <span v-if="width">{{ width }} × {{ height }} · {{ resolution }} m/px</span>
          </div>
          <div class="scene-actions">
            <select v-model="selectedName" :disabled="loading || saving" aria-label="切换场景" @change="switchScene">
              <option v-for="map in maps" :key="map.path" :value="map.name">{{ map.name }}</option>
            </select>
            <button @click="requestClose">关闭</button>
          </div>
        </header>

        <div class="editor-toolbar">
          <div class="tool-group">
            <button
              v-for="item in tools"
              :key="item.id"
              :class="{ active: tool === item.id }"
              @click="tool = item.id"
            >
              <i class="swatch" :class="item.id"></i>{{ item.label }}
            </button>
            <button :class="{ active: tool === 'pan' }" @click="tool = 'pan'">移动</button>
          </div>
          <label v-if="tool !== 'pan'" class="brush-control">
            笔刷 <input v-model.number="brushSize" type="range" min="1" max="40">
            <span>{{ brushSize }} px</span>
          </label>
          <div class="history-actions">
            <button :disabled="!undoCount" @click="undo">撤销</button>
            <button :disabled="!redoCount" @click="redo">重做</button>
          </div>
        </div>

        <div ref="containerRef" class="editor-workspace">
          <canvas
            ref="canvasRef"
            @pointerdown="onPointerDown"
            @pointermove="onPointerMove"
            @pointerup="onPointerUp"
            @pointercancel="onPointerUp"
            @pointerleave="onPointerLeave"
            @wheel.prevent="onWheel"
            @contextmenu.prevent
          />
          <div v-if="loading" class="editor-message">正在读取地图…</div>
          <div class="view-info">{{ cursorText }} · 缩放 {{ zoomText }}%</div>
        </div>

        <div v-if="errorMsg" class="error-message editor-error">{{ errorMsg }}</div>

        <footer class="editor-footer">
          <span :class="{ dirty }">{{ saving ? '正在保存…' : dirty ? '有未保存的修改' : '地图已保存' }}</span>
          <button :disabled="loading" @click="fitView">适应窗口</button>
          <div class="footer-spacer"></div>
          <button :disabled="loading || saving" @click="saveMap(true)">另存为场景</button>
          <button class="primary-button" :disabled="loading || saving || !dirty" @click="saveMap(false)">保存修改</button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { API_BASE } from '../config.js'

const props = defineProps({
  mapName: { type: String, required: true },
  maps: { type: Array, default: () => [] }
})
const emit = defineEmits(['close', 'saved'])

const tools = [
  { id: 'occupied', label: '障碍', value: 0 },
  { id: 'free', label: '空闲', value: 254 },
  { id: 'unknown', label: '未知', value: 205 }
]
const containerRef = ref(null)
const canvasRef = ref(null)
const selectedName = ref(props.mapName)
const currentName = ref(props.mapName)
const width = ref(0)
const height = ref(0)
const resolution = ref(0.05)
const origin = ref([0, 0, 0])
const tool = ref('occupied')
const brushSize = ref(6)
const loading = ref(false)
const saving = ref(false)
const dirty = ref(false)
const errorMsg = ref('')
const scale = ref(1)
const offsetX = ref(0)
const offsetY = ref(0)
const cursor = ref(null)
const cursorInside = ref(false)
const undoCount = ref(0)
const redoCount = ref(0)

let pixels = new Uint8ClampedArray()
let mapCanvas = null
let mapContext = null
let mapImage = null
let isPainting = false
let isPanning = false
let lastPaintPoint = null
let lastPanPoint = null
let resizeObserver = null
const undoStack = []
const redoStack = []

const zoomText = computed(() => Math.round(scale.value * 100))
const cursorText = computed(() => {
  if (!cursor.value || !width.value) return '滚轮缩放，选择笔刷后直接编辑'
  const { x, y } = cursor.value
  if (x < 0 || y < 0 || x >= width.value || y >= height.value) return '地图区域外'
  const wx = origin.value[0] + x * resolution.value
  const wy = origin.value[1] + (height.value - 1 - y) * resolution.value
  return `像素 ${x}, ${y} · 坐标 ${wx.toFixed(2)}, ${wy.toFixed(2)} m`
})

function decodePixels(base64) {
  const binary = atob(base64)
  const result = new Uint8ClampedArray(binary.length)
  for (let i = 0; i < binary.length; i++) result[i] = binary.charCodeAt(i)
  return result
}

function encodePixels() {
  let binary = ''
  const chunkSize = 32768
  for (let i = 0; i < pixels.length; i += chunkSize) {
    binary += String.fromCharCode(...pixels.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

function pixelColor(value) {
  if (value === 205) return 'rgb(90, 100, 115)'
  return `rgb(${value}, ${value}, ${value})`
}

function refreshMapCanvas() {
  if (!mapCanvas || !width.value || !height.value) return
  mapImage = mapContext.createImageData(width.value, height.value)
  for (let i = 0; i < pixels.length; i++) {
    const value = pixels[i]
    const color = value === 205 ? [90, 100, 115] : [value, value, value]
    mapImage.data[i * 4] = color[0]
    mapImage.data[i * 4 + 1] = color[1]
    mapImage.data[i * 4 + 2] = color[2]
    mapImage.data[i * 4 + 3] = 255
  }
  mapContext.putImageData(mapImage, 0, 0)
}

function resizeCanvas() {
  const canvas = canvasRef.value
  const container = containerRef.value
  if (!canvas || !container) return
  canvas.width = container.clientWidth
  canvas.height = container.clientHeight
}

function draw() {
  const canvas = canvasRef.value
  if (!canvas || !mapCanvas) return
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#050b14'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.save()
  ctx.translate(offsetX.value, offsetY.value)
  ctx.scale(scale.value, scale.value)
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(mapCanvas, 0, 0)

  if (scale.value >= 8) {
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.12)'
    ctx.lineWidth = 1 / scale.value
    ctx.beginPath()
    for (let x = 0; x <= width.value; x++) {
      ctx.moveTo(x, 0)
      ctx.lineTo(x, height.value)
    }
    for (let y = 0; y <= height.value; y++) {
      ctx.moveTo(0, y)
      ctx.lineTo(width.value, y)
    }
    ctx.stroke()
  }
  ctx.restore()

  if (cursorInside.value && cursor.value && tool.value !== 'pan') {
    const screenX = offsetX.value + (cursor.value.x + 0.5) * scale.value
    const screenY = offsetY.value + (cursor.value.y + 0.5) * scale.value
    ctx.beginPath()
    ctx.arc(screenX, screenY, Math.max(2, brushSize.value * scale.value / 2), 0, Math.PI * 2)
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)'
    ctx.lineWidth = 1
    ctx.stroke()
  }
}

function fitView() {
  const container = containerRef.value
  if (!container || !width.value || !height.value) return
  const cw = container.clientWidth
  const ch = container.clientHeight
  if (!cw || !ch) return
  scale.value = Math.max(0.05, Math.min(50, Math.min((cw - 50) / width.value, (ch - 50) / height.value)))
  offsetX.value = (cw - width.value * scale.value) / 2
  offsetY.value = (ch - height.value * scale.value) / 2
  draw()
}

function eventPoint(event) {
  const canvas = canvasRef.value
  const rect = canvas.getBoundingClientRect()
  const sx = event.clientX - rect.left
  const sy = event.clientY - rect.top
  return {
    sx,
    sy,
    x: Math.floor((sx - offsetX.value) / scale.value),
    y: Math.floor((sy - offsetY.value) / scale.value)
  }
}

function paintAt(cx, cy) {
  const item = tools.find((entry) => entry.id === tool.value)
  if (!item) return
  const radius = Math.max(0.5, brushSize.value / 2)
  mapContext.fillStyle = pixelColor(item.value)
  for (let y = Math.floor(cy - radius); y <= Math.ceil(cy + radius); y++) {
    for (let x = Math.floor(cx - radius); x <= Math.ceil(cx + radius); x++) {
      if (x < 0 || y < 0 || x >= width.value || y >= height.value) continue
      if ((x - cx) ** 2 + (y - cy) ** 2 > radius ** 2) continue
      pixels[y * width.value + x] = item.value
      mapContext.fillRect(x, y, 1, 1)
    }
  }
}

function paintLine(from, to) {
  const steps = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y), 1)
  for (let i = 0; i <= steps; i++) {
    paintAt(
      Math.round(from.x + (to.x - from.x) * i / steps),
      Math.round(from.y + (to.y - from.y) * i / steps)
    )
  }
}

function updateHistory() {
  undoCount.value = undoStack.length
  redoCount.value = redoStack.length
}

function beginStroke() {
  undoStack.push(new Uint8ClampedArray(pixels))
  if (undoStack.length > 20) undoStack.shift()
  redoStack.length = 0
  updateHistory()
}

function undo() {
  if (!undoStack.length) return
  redoStack.push(new Uint8ClampedArray(pixels))
  pixels = undoStack.pop()
  refreshMapCanvas()
  dirty.value = true
  updateHistory()
  draw()
}

function redo() {
  if (!redoStack.length) return
  undoStack.push(new Uint8ClampedArray(pixels))
  pixels = redoStack.pop()
  refreshMapCanvas()
  dirty.value = true
  updateHistory()
  draw()
}

function onPointerDown(event) {
  if (loading.value || saving.value || !pixels.length) return
  cursorInside.value = true
  const point = eventPoint(event)
  cursor.value = { x: point.x, y: point.y }
  canvasRef.value.setPointerCapture(event.pointerId)
  if (tool.value === 'pan' || event.button === 1 || event.button === 2) {
    isPanning = true
    lastPanPoint = { x: point.sx, y: point.sy }
  } else if (event.button === 0) {
    isPainting = true
    beginStroke()
    paintAt(point.x, point.y)
    lastPaintPoint = { x: point.x, y: point.y }
    dirty.value = true
  }
  draw()
}

function onPointerMove(event) {
  const point = eventPoint(event)
  cursor.value = { x: point.x, y: point.y }
  cursorInside.value = true
  if (isPainting && lastPaintPoint) {
    paintLine(lastPaintPoint, point)
    lastPaintPoint = { x: point.x, y: point.y }
    dirty.value = true
  } else if (isPanning && lastPanPoint) {
    offsetX.value += point.sx - lastPanPoint.x
    offsetY.value += point.sy - lastPanPoint.y
    lastPanPoint = { x: point.sx, y: point.sy }
  }
  draw()
}

function onPointerUp() {
  isPainting = false
  isPanning = false
  lastPaintPoint = null
  lastPanPoint = null
}

function onPointerLeave() {
  cursorInside.value = false
  if (!isPainting && !isPanning) draw()
}

function onWheel(event) {
  const point = eventPoint(event)
  const oldScale = scale.value
  const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15
  const newScale = Math.max(0.05, Math.min(50, oldScale * factor))
  offsetX.value = point.sx - (point.sx - offsetX.value) * newScale / oldScale
  offsetY.value = point.sy - (point.sy - offsetY.value) * newScale / oldScale
  scale.value = newScale
  draw()
}

async function loadMap(name) {
  loading.value = true
  errorMsg.value = ''
  try {
    const res = await fetch(`${API_BASE}/maps/${encodeURIComponent(name)}/content`)
    const data = await res.json()
    if (!res.ok || !data.success) throw new Error(data.error || '地图读取失败')
    width.value = data.width
    height.value = data.height
    resolution.value = data.resolution
    origin.value = data.origin
    pixels = decodePixels(data.pixels)
    mapCanvas = document.createElement('canvas')
    mapCanvas.width = data.width
    mapCanvas.height = data.height
    mapContext = mapCanvas.getContext('2d')
    refreshMapCanvas()
    currentName.value = name
    selectedName.value = name
    dirty.value = false
    undoStack.length = 0
    redoStack.length = 0
    updateHistory()
    await nextTick()
    resizeCanvas()
    fitView()
  } catch (err) {
    errorMsg.value = err.message
  } finally {
    loading.value = false
  }
}

async function switchScene() {
  if (selectedName.value === currentName.value) return
  if (dirty.value && !window.confirm('当前地图有未保存修改，确定放弃并切换场景吗？')) {
    selectedName.value = currentName.value
    return
  }
  await loadMap(selectedName.value)
}

async function saveMap(saveAs) {
  let newName
  if (saveAs) {
    newName = window.prompt('请输入新场景名称：', `${currentName.value}_edited`)
    if (newName === null) return
    if (!newName.trim()) {
      errorMsg.value = '场景名称不能为空'
      return
    }
  }
  saving.value = true
  errorMsg.value = ''
  try {
    const body = { width: width.value, height: height.value, pixels: encodePixels() }
    if (saveAs) body.newName = newName.trim()
    const res = await fetch(`${API_BASE}/maps/${encodeURIComponent(currentName.value)}/content`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    const data = await res.json()
    if (!res.ok || !data.success) throw new Error(data.error || '保存失败')
    currentName.value = data.map.name
    selectedName.value = data.map.name
    dirty.value = false
    emit('saved', data)
  } catch (err) {
    errorMsg.value = err.message
  } finally {
    saving.value = false
  }
}

function requestClose() {
  if (dirty.value && !window.confirm('地图有未保存修改，确定关闭吗？')) return
  emit('close')
}

function onKeyDown(event) {
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(event.target.tagName)) return
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault()
    if (dirty.value && !saving.value) saveMap(false)
  } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault()
    if (event.shiftKey) redo()
    else undo()
  }
}

onMounted(() => {
  resizeObserver = new ResizeObserver(() => {
    resizeCanvas()
    draw()
  })
  if (containerRef.value) resizeObserver.observe(containerRef.value)
  window.addEventListener('keydown', onKeyDown)
  loadMap(props.mapName)
})

onUnmounted(() => {
  resizeObserver?.disconnect()
  window.removeEventListener('keydown', onKeyDown)
})
</script>

<style scoped>
.editor-overlay { position: fixed; inset: 0; z-index: 1200; display: grid; place-items: center; padding: 20px; background: rgba(2, 6, 14, 0.82); backdrop-filter: blur(8px); }
.map-editor { display: flex; flex-direction: column; width: min(1200px, 96vw); height: min(860px, 92vh); overflow: hidden; border: 1px solid var(--border-strong); border-radius: var(--radius-lg); background: var(--bg-card); box-shadow: 0 24px 80px rgba(0, 0, 0, 0.45); }
.editor-header { display: flex; align-items: center; justify-content: space-between; gap: 15px; padding: 14px 16px; border-bottom: 1px solid var(--border-color); }
.editor-header h2 { font-size: 0.95rem; font-weight: 600; }
.editor-header span { display: block; margin-top: 5px; color: var(--text-muted); font-family: var(--font-mono); font-size: 0.65rem; }
.scene-actions { display: flex; gap: 8px; }
.scene-actions select { max-width: 240px; height: 34px; padding: 0 9px; border: 1px solid var(--border-color); border-radius: 7px; color: var(--text-primary); background: var(--bg-secondary); }
.scene-actions button, .editor-toolbar button, .editor-footer button { min-height: 32px; padding: 0 11px; border: 1px solid var(--border-color); border-radius: 7px; color: var(--text-secondary); background: var(--bg-soft); font-size: 0.7rem; cursor: pointer; }
.editor-toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; padding: 10px 16px; border-bottom: 1px solid var(--border-color); }
.tool-group, .history-actions { display: flex; gap: 6px; }
.tool-group button, .history-actions button { display: flex; align-items: center; gap: 6px; }
.editor-toolbar button.active { border-color: rgba(34, 211, 238, 0.35); color: var(--accent-primary); background: rgba(34, 211, 238, 0.07); }
.swatch { width: 10px; height: 10px; border: 1px solid rgba(255, 255, 255, 0.25); border-radius: 2px; }
.swatch.occupied { background: #000; }
.swatch.free { background: #fefefe; }
.swatch.unknown { background: #5a6473; }
.brush-control { display: flex; align-items: center; gap: 8px; color: var(--text-muted); font-size: 0.68rem; }
.brush-control input { width: 110px; }
.brush-control span { width: 38px; font-family: var(--font-mono); }
.history-actions { margin-left: auto; }
.editor-workspace { position: relative; flex: 1; min-height: 0; overflow: hidden; background: #050b14; }
.editor-workspace canvas { display: block; width: 100%; height: 100%; cursor: crosshair; touch-action: none; }
.editor-message { position: absolute; inset: 0; display: grid; place-items: center; color: var(--text-secondary); background: rgba(5, 11, 20, 0.75); }
.view-info { position: absolute; left: 12px; bottom: 10px; padding: 5px 8px; border-radius: 6px; color: var(--text-secondary); background: rgba(2, 6, 14, 0.75); font-family: var(--font-mono); font-size: 0.62rem; pointer-events: none; }
.editor-error { margin: 10px 16px 0; }
.editor-footer { display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--border-color); }
.editor-footer > span { color: var(--text-muted); font-size: 0.68rem; }
.editor-footer > span.dirty { color: var(--warning); }
.footer-spacer { flex: 1; }
.editor-footer .primary-button { border-color: transparent; color: white; background: var(--accent-gradient); }
@media (max-width: 700px) {
  .editor-overlay { padding: 0; }
  .map-editor { width: 100vw; height: 100dvh; border-radius: 0; }
  .editor-header, .editor-footer { flex-wrap: wrap; }
  .scene-actions select { max-width: 180px; }
  .history-actions { margin-left: 0; }
  .footer-spacer { display: none; }
}
</style>
