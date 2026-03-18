<template>
  <div class="card lidar-card">
    <div class="card-header">
      <div class="header-left">3D 激光点云 (顶视)</div>
      <div class="header-right">
        <span class="lidar-stat">{{ pointCountText }}</span>
        <button class="btn-mini" @click="resetView" :disabled="!hasData">重置视图</button>
      </div>
    </div>
    <div class="card-body">
      <div v-if="!connected" class="lidar-placeholder">请先连接机器人</div>
      <div v-else-if="!hasData" class="lidar-placeholder">等待点云数据...</div>
      <div v-else class="lidar-canvas-wrap" ref="containerRef">
        <canvas ref="canvasRef" />
        <div class="lidar-overlay">
          <div class="lidar-controls">
            <label>
              点大小
              <input type="range" min="1" max="4" v-model.number="pointSize" />
            </label>
            <label>
              最大点数
              <input type="range" min="5000" max="80000" step="5000" v-model.number="maxPoints" />
            </label>
            <label class="toggle">
              <input type="checkbox" v-model="useIntensity" />
              <span>按强度着色</span>
            </label>
          </div>
          <div class="lidar-meta">
            <div>范围: {{ extentText }}</div>
            <div>缩放: ×{{ zoom.toFixed(2) }}</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'

const props = defineProps({
  connected: Boolean,
  lidarData: Object
})

const canvasRef = ref(null)
const containerRef = ref(null)
const pointSize = ref(2)
const maxPoints = ref(30000)
const useIntensity = ref(true)
const zoom = ref(1)

const points = ref([])
const bounds = ref({ minX: 0, maxX: 0, minY: 0, maxY: 0 })
const intensityRange = ref({ min: 0, max: 1 })

const hasData = computed(() => Array.isArray(points.value) && points.value.length > 0)
const pointCountText = computed(() => hasData.value ? `点数: ${points.value.length}` : '点数: --')
const extentText = computed(() => {
  if (!hasData.value) return '--'
  const b = bounds.value
  const dx = (b.maxX - b.minX).toFixed(2)
  const dy = (b.maxY - b.minY).toFixed(2)
  return `${dx}m × ${dy}m`
})

let resizeObserver = null

function resetView() {
  zoom.value = 1
  draw()
}

function parsePointCloud(pc) {
  if (!pc || !pc.data || !pc.fields || !pc.point_step) return []

  const fields = new Map()
  for (const f of pc.fields) fields.set(f.name, f)

  const fieldX = fields.get('x')
  const fieldY = fields.get('y')
  const fieldZ = fields.get('z')
  const fieldI = fields.get('intensity') || fields.get('reflectivity')

  if (!fieldX || !fieldY) return []
  if (fieldX.datatype !== 7 || fieldY.datatype !== 7 || (fieldZ && fieldZ.datatype !== 7)) return []

  const data = pc.data
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const step = pc.point_step
  const totalPoints = pc.width * pc.height || Math.floor(data.byteLength / step)
  const stride = Math.max(1, Math.ceil(totalPoints / maxPoints.value))
  const little = !pc.is_bigendian

  const parsed = []
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  let minI = Infinity, maxI = -Infinity

  for (let i = 0; i < totalPoints; i += stride) {
    const base = i * step
    if (base + step > data.byteLength) break

    const x = view.getFloat32(base + fieldX.offset, little)
    const y = view.getFloat32(base + fieldY.offset, little)
    const z = fieldZ ? view.getFloat32(base + fieldZ.offset, little) : 0
    const intensity = fieldI && fieldI.datatype === 7
      ? view.getFloat32(base + fieldI.offset, little)
      : 0

    if (!Number.isFinite(x) || !Number.isFinite(y)) continue

    parsed.push({ x, y, z, intensity })

    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
    if (Number.isFinite(intensity)) {
      if (intensity < minI) minI = intensity
      if (intensity > maxI) maxI = intensity
    }
  }

  if (parsed.length === 0) return []

  bounds.value = { minX, maxX, minY, maxY }
  intensityRange.value = {
    min: Number.isFinite(minI) ? minI : 0,
    max: Number.isFinite(maxI) && maxI !== minI ? maxI : (Number.isFinite(minI) ? minI + 1 : 1)
  }

  return parsed
}

function colorFromIntensity(i) {
  const r = intensityRange.value
  const t = (i - r.min) / (r.max - r.min)
  const clamped = Math.max(0, Math.min(1, t))
  const v = Math.round(60 + clamped * 195)
  return `rgb(${v}, ${v}, ${v})`
}

function resizeCanvas() {
  const canvas = canvasRef.value
  const container = containerRef.value
  if (!canvas || !container) return

  const rect = container.getBoundingClientRect()
  const ratio = window.devicePixelRatio || 1
  canvas.width = Math.max(1, Math.floor(rect.width * ratio))
  canvas.height = Math.max(1, Math.floor(rect.height * ratio))
  canvas.style.width = `${rect.width}px`
  canvas.style.height = `${rect.height}px`
  draw()
}

function draw() {
  const canvas = canvasRef.value
  if (!canvas || !hasData.value) return

  const ctx = canvas.getContext('2d')
  if (!ctx) return

  const width = canvas.width
  const height = canvas.height
  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = '#0b0f16'
  ctx.fillRect(0, 0, width, height)

  const { minX, maxX, minY, maxY } = bounds.value
  const spanX = Math.max(0.01, maxX - minX)
  const spanY = Math.max(0.01, maxY - minY)
  const scale = Math.min(width / spanX, height / spanY) * 0.9 * zoom.value
  const centerX = (minX + maxX) / 2
  const centerY = (minY + maxY) / 2

  ctx.save()
  ctx.translate(width / 2, height / 2)
  ctx.scale(1, -1)

  const size = pointSize.value
  for (const p of points.value) {
    const x = (p.x - centerX) * scale
    const y = (p.y - centerY) * scale
    if (useIntensity.value) {
      ctx.fillStyle = colorFromIntensity(p.intensity)
    } else {
      ctx.fillStyle = '#5ee0ff'
    }
    ctx.fillRect(x, y, size, size)
  }
  ctx.restore()
}

watch(() => props.lidarData, (val) => {
  points.value = parsePointCloud(val)
  draw()
})

watch([pointSize, maxPoints, useIntensity, zoom], () => {
  if (props.lidarData) {
    points.value = parsePointCloud(props.lidarData)
  }
  draw()
})

onMounted(() => {
  resizeCanvas()
  resizeObserver = new ResizeObserver(() => resizeCanvas())
  if (containerRef.value) resizeObserver.observe(containerRef.value)
})

onUnmounted(() => {
  if (resizeObserver && containerRef.value) resizeObserver.unobserve(containerRef.value)
  resizeObserver = null
})
</script>

<style scoped>
.lidar-card {
  min-height: 280px;
}

.lidar-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 220px;
  color: #8a93a5;
}

.lidar-canvas-wrap {
  position: relative;
  width: 100%;
  height: 260px;
  border-radius: 12px;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.08);
}

.lidar-canvas-wrap canvas {
  display: block;
  width: 100%;
  height: 100%;
}

.lidar-overlay {
  position: absolute;
  inset: 0;
  pointer-events: none;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  padding: 10px 12px;
  color: #c7d0e0;
  font-size: 12px;
}

.lidar-controls {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  background: rgba(8, 12, 18, 0.65);
  border-radius: 10px;
  padding: 6px 10px;
  pointer-events: auto;
}

.lidar-controls label {
  display: flex;
  align-items: center;
  gap: 6px;
}

.lidar-controls input[type="range"] {
  width: 90px;
}

.lidar-controls .toggle {
  gap: 6px;
}

.lidar-controls .toggle input {
  margin: 0;
}

.lidar-meta {
  align-self: flex-end;
  background: rgba(8, 12, 18, 0.65);
  border-radius: 10px;
  padding: 6px 10px;
}

.lidar-stat {
  font-size: 12px;
  color: #9fb0c9;
  margin-right: 8px;
}
</style>
