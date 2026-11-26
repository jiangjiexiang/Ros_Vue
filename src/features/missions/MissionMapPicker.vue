<template>
  <section class="mission-panel map-picker-panel">
    <div class="panel-heading">
      <div>
        <h2>地图可视化选点</h2>
        <span>{{ mapMetaText }}</span>
      </div>
      <div class="picker-actions">
        <button type="button" class="mission-button small" @click="fitView">适应视图</button>
      </div>
    </div>

    <div ref="containerRef" class="picker-stage">
      <canvas
        ref="canvasRef"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
        @pointerleave="cursorWorld = null"
        @wheel.prevent="onWheel"
        @contextmenu.prevent
      />
      <div v-if="loading" class="picker-overlay">正在加载地图图像…</div>
      <div class="picker-hud">
        <span v-if="cursorWorld">X {{ cursorWorld.x.toFixed(2) }} m · Y {{ cursorWorld.y.toFixed(2) }} m</span>
        <span v-else>左键点击空白添加巡检点 · 点击圆点选中 · 右键拖动平移 · 滚轮缩放</span>
      </div>
    </div>
  </section>
</template>

<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { API_BASE, apiFetch } from '../../config.js'

const props = defineProps({
  mapName: { type: String, default: '' },
  waypoints: { type: Array, default: () => [] },
  selectedWaypointId: { type: String, default: '' },
  disabled: { type: Boolean, default: false }
})

const emit = defineEmits(['add-point', 'select-point'])

const containerRef = ref(null)
const canvasRef = ref(null)
const loading = ref(false)
const hasPgm = ref(false)
const cursorWorld = ref(null)

const worldMeta = ref({
  width: 400,
  height: 400,
  resolution: 0.05,
  origin: [-10, -10, 0]
})

const scale = ref(1.2)
const offsetX = ref(0)
const offsetY = ref(0)

let pgmCanvas = null
let resizeObserver = null
let isPanning = false
let pointerDownPos = null
let lastPanPos = null
let loadGeneration = 0

const mapMetaText = computed(() => {
  if (loading.value) return '正在加载地图…'
  if (hasPgm.value) {
    return `${props.mapName} · ${worldMeta.value.width}×${worldMeta.value.height} · ${worldMeta.value.resolution} m/px`
  }
  return props.mapName
    ? `${props.mapName}（无 PGM 图像，已切换米制坐标网格）`
    : '米制坐标网格（-10m ~ +10m）'
})

function decodePgmPixels(base64, width, height) {
  const binary = atob(base64)
  const offscreen = document.createElement('canvas')
  offscreen.width = width
  offscreen.height = height
  const ctx = offscreen.getContext('2d')
  const img = ctx.createImageData(width, height)
  for (let i = 0; i < width * height && i < binary.length; i++) {
    const val = binary.charCodeAt(i)
    const r = val === 205 ? 42 : val
    const g = val === 205 ? 54 : val
    const b = val === 205 ? 72 : val
    img.data[i * 4] = r
    img.data[i * 4 + 1] = g
    img.data[i * 4 + 2] = b
    img.data[i * 4 + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  return offscreen
}

async function loadMapContent() {
  const generation = ++loadGeneration
  const name = (props.mapName || '').trim()
  pgmCanvas = null
  hasPgm.value = false
  worldMeta.value = { width: 400, height: 400, resolution: 0.05, origin: [-10, -10, 0] }

  if (!name) {
    await nextTick()
    fitView()
    return
  }

  loading.value = true
  try {
    const res = await apiFetch(`${API_BASE}/maps/${encodeURIComponent(name)}/content`)
    if (res.ok) {
      const data = await res.json()
      if (generation !== loadGeneration) return
      if (data.success && data.width && data.height && data.pixels) {
        worldMeta.value = {
          width: data.width,
          height: data.height,
          resolution: Number(data.resolution) || 0.05,
          origin: Array.isArray(data.origin) ? data.origin : [0, 0, 0]
        }
        pgmCanvas = decodePgmPixels(data.pixels, data.width, data.height)
        hasPgm.value = true
      }
    }
  } catch {}
  finally {
    if (generation === loadGeneration) {
      loading.value = false
      await nextTick()
      fitView()
    }
  }
}

function worldToMapPx(wx, wy) {
  const { height, resolution, origin } = worldMeta.value
  return {
    px: (wx - origin[0]) / resolution,
    py: height - 1 - (wy - origin[1]) / resolution
  }
}

function screenToWorld(sx, sy) {
  const { height, resolution, origin } = worldMeta.value
  const px = (sx - offsetX.value) / scale.value
  const py = (sy - offsetY.value) / scale.value
  return {
    x: origin[0] + px * resolution,
    y: origin[1] + (height - 1 - py) * resolution
  }
}

function mapPxToScreen(px, py) {
  return {
    sx: offsetX.value + px * scale.value,
    sy: offsetY.value + py * scale.value
  }
}

function resizeCanvas() {
  const canvas = canvasRef.value
  const container = containerRef.value
  if (!canvas || !container) return
  canvas.width = container.clientWidth
  canvas.height = container.clientHeight
}

function fitView() {
  resizeCanvas()
  const canvas = canvasRef.value
  if (!canvas) return
  const { width, height } = worldMeta.value
  const pad = 32
  scale.value = Math.max(0.2, Math.min(20, Math.min((canvas.width - pad) / width, (canvas.height - pad) / height)))
  offsetX.value = (canvas.width - width * scale.value) / 2
  offsetY.value = (canvas.height - height * scale.value) / 2
  draw()
}

function draw() {
  const canvas = canvasRef.value
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#050c16'
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  const { width, height, resolution, origin } = worldMeta.value

  ctx.save()
  ctx.translate(offsetX.value, offsetY.value)
  ctx.scale(scale.value, scale.value)

  if (pgmCanvas) {
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(pgmCanvas, 0, 0)
  } else {
    ctx.fillStyle = '#091525'
    ctx.fillRect(0, 0, width, height)
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.14)'
    ctx.lineWidth = 1 / scale.value
    const stepPx = 1 / resolution
    ctx.beginPath()
    for (let x = 0; x <= width; x += stepPx) {
      ctx.moveTo(x, 0)
      ctx.lineTo(x, height)
    }
    for (let y = 0; y <= height; y += stepPx) {
      ctx.moveTo(0, y)
      ctx.lineTo(width, y)
    }
    ctx.stroke()

    const zero = worldToMapPx(0, 0)
    ctx.strokeStyle = 'rgba(34, 211, 238, 0.35)'
    ctx.beginPath()
    ctx.moveTo(0, zero.py)
    ctx.lineTo(width, zero.py)
    ctx.moveTo(zero.px, 0)
    ctx.lineTo(zero.px, height)
    ctx.stroke()
  }

  ctx.strokeStyle = 'rgba(148, 163, 184, 0.25)'
  ctx.lineWidth = 1 / scale.value
  ctx.strokeRect(0, 0, width, height)
  ctx.restore()

  // Draw waypoint connecting path and markers in screen space for crisp labels
  const points = (props.waypoints || []).map((wp, idx) => {
    const { px, py } = worldToMapPx(Number(wp.pose?.x || 0), Number(wp.pose?.y || 0))
    const { sx, sy } = mapPxToScreen(px, py)
    return { wp, idx, sx, sy }
  })

  if (points.length >= 2) {
    ctx.save()
    ctx.strokeStyle = 'rgba(34, 211, 238, 0.7)'
    ctx.lineWidth = 2
    ctx.setLineDash([6, 4])
    ctx.beginPath()
    points.forEach((p, i) => {
      if (i === 0) ctx.moveTo(p.sx, p.sy)
      else ctx.lineTo(p.sx, p.sy)
    })
    ctx.stroke()
    ctx.restore()
  }

  for (const p of points) {
    const selected = p.wp.id === props.selectedWaypointId
    const yaw = Number(p.wp.pose?.yaw || 0)

    // Direction arrow
    const arrowLen = selected ? 22 : 17
    const ax = p.sx + Math.cos(-yaw) * arrowLen
    const ay = p.sy + Math.sin(-yaw) * arrowLen
    ctx.strokeStyle = selected ? '#fbbf24' : '#22d3ee'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(p.sx, p.sy)
    ctx.lineTo(ax, ay)
    ctx.stroke()

    // Circle badge
    ctx.beginPath()
    ctx.arc(p.sx, p.sy, selected ? 13 : 11, 0, Math.PI * 2)
    ctx.fillStyle = selected ? '#fbbf24' : '#0891b2'
    ctx.fill()
    ctx.lineWidth = 2
    ctx.strokeStyle = selected ? '#fef3c7' : '#cffafe'
    ctx.stroke()

    ctx.fillStyle = '#04101d'
    ctx.font = 'bold 11px monospace'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(String(p.idx + 1), p.sx, p.sy)
  }
}

function eventCoords(event) {
  const rect = canvasRef.value.getBoundingClientRect()
  return { sx: event.clientX - rect.left, sy: event.clientY - rect.top }
}

function onPointerDown(event) {
  const pos = eventCoords(event)
  pointerDownPos = pos
  if (event.button === 1 || event.button === 2 || event.shiftKey) {
    isPanning = true
    lastPanPos = pos
    canvasRef.value.setPointerCapture(event.pointerId)
  }
}

function onPointerMove(event) {
  const pos = eventCoords(event)
  cursorWorld.value = screenToWorld(pos.sx, pos.sy)
  if (isPanning && lastPanPos) {
    offsetX.value += pos.sx - lastPanPos.x
    offsetY.value += pos.sy - lastPanPos.y
    lastPanPos = pos
    draw()
  }
}

function onPointerUp(event) {
  const pos = eventCoords(event)
  if (isPanning) {
    isPanning = false
    lastPanPos = null
    return
  }
  if (event.button !== 0 || !pointerDownPos) return
  const moved = Math.hypot(pos.sx - pointerDownPos.sx, pos.sy - pointerDownPos.sy)
  pointerDownPos = null
  if (moved > 5) return

  // Hit-test existing waypoints first
  for (const wp of props.waypoints || []) {
    const { px, py } = worldToMapPx(Number(wp.pose?.x || 0), Number(wp.pose?.y || 0))
    const screen = mapPxToScreen(px, py)
    if (Math.hypot(pos.sx - screen.sx, pos.sy - screen.sy) <= 15) {
      emit('select-point', wp.id)
      return
    }
  }

  if (props.disabled) return
  const world = screenToWorld(pos.sx, pos.sy)
  emit('add-point', {
    x: Number(world.x.toFixed(2)),
    y: Number(world.y.toFixed(2)),
    yaw: 0
  })
}

function onWheel(event) {
  const pos = eventCoords(event)
  const oldScale = scale.value
  const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15
  const nextScale = Math.max(0.2, Math.min(25, oldScale * factor))
  offsetX.value = pos.sx - ((pos.sx - offsetX.value) * nextScale) / oldScale
  offsetY.value = pos.sy - ((pos.sy - offsetY.value) * nextScale) / oldScale
  scale.value = nextScale
  draw()
}

watch(() => props.mapName, loadMapContent, { immediate: true })
watch([() => props.waypoints, () => props.selectedWaypointId], draw, { deep: true })

onMounted(() => {
  resizeObserver = new ResizeObserver(() => {
    resizeCanvas()
    draw()
  })
  if (containerRef.value) resizeObserver.observe(containerRef.value)
})

onUnmounted(() => {
  loadGeneration += 1
  resizeObserver?.disconnect()
})
</script>

<style scoped>
.map-picker-panel {
  overflow: hidden;
}
.map-picker-panel .panel-heading > div:first-child {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
}
.map-picker-panel .panel-heading span {
  color: var(--text-muted);
  font-size: var(--text-xs);
}
.picker-stage {
  position: relative;
  height: 360px;
  background: #050c16;
}
.picker-stage canvas {
  display: block;
  width: 100%;
  height: 100%;
  cursor: crosshair;
  touch-action: none;
}
.picker-overlay {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: var(--text-secondary);
  background: rgba(5, 12, 22, 0.72);
  font-size: var(--text-sm);
}
.picker-hud {
  position: absolute;
  left: 12px;
  bottom: 10px;
  padding: 5px 10px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  color: var(--text-secondary);
  background: rgba(7, 17, 31, 0.85);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  pointer-events: none;
}
</style>
