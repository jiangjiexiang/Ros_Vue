<template>
  <div class="card map-card">
    <div class="card-header">
      <div class="header-left">
        <span class="icon">🗺️</span> SLAM 栅格地图
      </div>
      <div class="header-right" v-if="hasMap">
        <button class="btn-mini" @click="resetView">重置视图</button>
      </div>
    </div>
    <div class="card-body">
      <div 
        v-if="hasMap" 
        class="map-canvas-container"
        ref="containerRef"
        @wheel.prevent="onWheel"
        @mousedown="onMouseDown"
        @mousemove="onMouseMove"
        @mouseup="onMouseUp"
        @mouseleave="onMouseUp"
        @touchstart.passive="onTouchStart"
        @touchmove.prevent="onTouchMove"
        @touchend="onMouseUp"
      >
        <canvas ref="mapCanvasRef" />
        <div class="map-info" v-if="mapInfo">
          {{ mapInfo.width }} × {{ mapInfo.height }} | 缩放: {{ (scale * 100).toFixed(0) }}%
        </div>
      </div>
      <div v-else class="map-placeholder">
        <span class="icon">🗺️</span>
        <p v-if="!connected">请先连接机器人</p>
        <p v-else>等待地图数据 (/map)...</p>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick, onMounted } from 'vue'

const props = defineProps({
  connected: Boolean,
  mapData: Object,
  scanData: Object,
  tfData: Object
})

const containerRef = ref(null)
const mapCanvasRef = ref(null)
const mapInfo = ref(null)

// 离屏 Canvas，用于存储渲染好的地图图像
let offscreenCanvas = null

// 视图变换状态
const scale = ref(1.0)
const offsetX = ref(0)
const offsetY = ref(0)

// 机器人与雷达状态
const robotPose = ref(null) // { x, y, yaw } in map frame
const laserPoints = ref([]) // Array of { x, y } in map frame

// 交互状态
let isDragging = false
let lastMouseX = 0
let lastMouseY = 0

const hasMap = computed(() => {
  return props.mapData && props.mapData.info && props.mapData.data
})

/**
 * 将 OccupancyGrid 原始数据生成图像到离屏 Canvas
 * 注意：ROS 坐标系 y 轴向上，ImageData y 轴向下，需要翻转渲染
 */
function updateOffscreenCanvas(occupancyGrid) {
  const info = occupancyGrid.info
  const data = occupancyGrid.data
  const width = info.width
  const height = info.height

  if (!width || !height || !data || data.length === 0) return

  if (!offscreenCanvas) {
    offscreenCanvas = document.createElement('canvas')
  }
  offscreenCanvas.width = width
  offscreenCanvas.height = height

  const ctx = offscreenCanvas.getContext('2d')
  const imageData = ctx.createImageData(width, height)
  const pixels = imageData.data

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const rosIdx = y * width + x
      const val = data[rosIdx]
      
      // 翻转 Y：Canvas 的第 (height-1-y) 行对应 ROS 的第 y 行
      const canvasIdx = ((height - 1 - y) * width + x) * 4
      
      let r, g, b
      if (val === -1) { r = 60; g = 60; b = 65 } // 未知：深灰蓝
      else if (val === 0) { r = 240; g = 240; b = 245 } // 无障碍：浅白
      else if (val === 100) { r = 30; g = 30; b = 40 } // 障碍物：深黑
      else {
        const intensity = 255 - Math.round((val / 100) * 180)
        r = g = b = intensity
      }
      pixels[canvasIdx] = r
      pixels[canvasIdx + 1] = g
      pixels[canvasIdx + 2] = b
      pixels[canvasIdx + 3] = 255
    }
  }
  ctx.putImageData(imageData, 0, 0)
  
  mapInfo.value = { width, height, resolution: info.resolution }
  
  // 仅在第一次或重置时自动对齐
  if (scale.value === 1.0 && offsetX.value === 0) {
    autoFit()
  } else {
    draw()
  }
}

/**
 * 转换世界坐标 (米) 到地图图像像素坐标
 */
function worldToPixel(wx, wy) {
  if (!props.mapData || !props.mapData.info) return { x: 0, y: 0 }
  const info = props.mapData.info
  const origin = info.origin.position
  const res = info.resolution
  
  // 1. 相对于 origin 的偏移 (米)
  const dx = wx - origin.x
  const dy = wy - origin.y
  
  // 2. 转换为像素，并处理 Y 轴翻转 (ROS Y 向上, Canvas Y 向下)
  return {
    x: dx / res,
    y: (info.height - 1) - (dy / res)
  }
}

/**
 * 绘图逻辑：绘制地图、激光、机器人
 */
function draw() {
  const canvas = mapCanvasRef.value
  const container = containerRef.value
  if (!canvas || !container || !offscreenCanvas) return

  canvas.width = container.clientWidth
  canvas.height = container.clientHeight
  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, canvas.width, canvas.height)

  ctx.save()
  ctx.translate(offsetX.value, offsetY.value)
  ctx.scale(scale.value, scale.value)
  ctx.imageSmoothingEnabled = false 
  
  // 1. 画地图
  ctx.drawImage(offscreenCanvas, 0, 0)

  // 2. 画雷达点 (红色)
  if (laserPoints.value.length > 0) {
    ctx.fillStyle = '#ff4444'
    for (const p of laserPoints.value) {
      const pix = worldToPixel(p.x, p.y)
      ctx.beginPath()
      ctx.arc(pix.x, pix.y, 1.5 / scale.value, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  // 3. 画机器人 (蓝色箭头)
  if (robotPose.value) {
    const pix = worldToPixel(robotPose.value.x, robotPose.value.y)
    ctx.save()
    ctx.translate(pix.x, pix.y)
    ctx.rotate(-robotPose.value.yaw) // 调整旋转方向
    
    // 画小车主体
    ctx.fillStyle = '#6366f1'
    ctx.beginPath()
    ctx.moveTo(8 / scale.value, 0)
    ctx.lineTo(-6 / scale.value, -6 / scale.value)
    ctx.lineTo(-6 / scale.value, 6 / scale.value)
    ctx.closePath()
    ctx.fill()
    
    // 画个描边增加立体感
    ctx.strokeStyle = '#fff'
    ctx.lineWidth = 1 / scale.value
    ctx.stroke()
    ctx.restore()
  }

  ctx.restore()
}

// 处理 TF 数据：提取机器人位置
watch(() => props.tfData, (newData) => {
  if (!newData || !newData.transforms) return
  // 尝试寻找 map -> base_link
  const t = newData.transforms.find(tf => tf.child_frame_id.includes('base_link') || tf.child_frame_id.includes('base_footprint'))
  if (t) {
    robotPose.value = {
      x: t.transform.translation.x,
      y: t.transform.translation.y,
      // Quaternion -> Yaw
      yaw: (() => {
        const q = t.transform.rotation
        return Math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.y * q.y + q.z * q.z))
      })()
    }
    draw()
  }
}, { deep: true })

// 处理雷达数据：计算打击点坐标
watch(() => props.scanData, (newData) => {
  if (!newData || !newData.ranges || !robotPose.value) return
  
  const points = []
  const { x: rx, y: ry, yaw: ryaw } = robotPose.value
  
  for (let i = 0; i < newData.ranges.length; i++) {
    const r = newData.ranges[i]
    if (r < newData.range_min || r > newData.range_max) continue
    
    const angle = newData.angle_min + i * newData.angle_increment
    // 简化：假设雷达在机器人中心，且坐标轴一致
    const totalAngle = ryaw + angle
    points.push({
      x: rx + r * Math.cos(totalAngle),
      y: ry + r * Math.sin(totalAngle)
    })
  }
  laserPoints.value = points
  draw()
}, { deep: true })

function autoFit() {
  if (!offscreenCanvas || !containerRef.value) return
  const container = containerRef.value
  const cw = container.clientWidth
  const ch = container.clientHeight
  const mw = offscreenCanvas.width
  const mh = offscreenCanvas.height

  if (cw === 0 || ch === 0) return

  // 计算缩放：使图像完整放入容器，且充满其中一个维度
  const s = Math.min(cw / mw, ch / mh)
  scale.value = s
  offsetX.value = (cw - mw * s) / 2
  offsetY.value = (ch - mh * s) / 2
  draw()
}

function resetView() {
  autoFit()
}

// ---- 事件处理 ----
function onWheel(e) {
  const zoomSpeed = 0.1
  const oldScale = scale.value
  const delta = -Math.sign(e.deltaY)
  const newScale = Math.max(0.1, Math.min(20, oldScale * (1 + delta * zoomSpeed)))
  
  // 获取鼠标在 Canvas 上的相对坐标
  const rect = containerRef.value.getBoundingClientRect()
  const mouseX = e.clientX - rect.left
  const mouseY = e.clientY - rect.top

  // 以鼠标位置为中心缩放
  offsetX.value = mouseX - (mouseX - offsetX.value) * (newScale / oldScale)
  offsetY.value = mouseY - (mouseY - offsetY.value) * (newScale / oldScale)
  
  scale.value = newScale
  draw()
}

function onMouseDown(e) {
  isDragging = true
  lastMouseX = e.clientX
  lastMouseY = e.clientY
}

function onMouseMove(e) {
  if (!isDragging) return
  const dx = e.clientX - lastMouseX
  const dy = e.clientY - lastMouseY
  offsetX.value += dx
  offsetY.value += dy
  lastMouseX = e.clientX
  lastMouseY = e.clientY
  draw()
}

function onMouseUp() {
  isDragging = false
}

// 触摸支持
function onTouchStart(e) {
  if (e.touches.length === 1) {
    onMouseDown(e.touches[0])
  }
}

function onTouchMove(e) {
  if (e.touches.length === 1) {
    onMouseMove(e.touches[0])
  }
}

// 监听窗口大小变化
window.addEventListener('resize', draw)

watch(() => props.mapData, (newData) => {
  if (newData && newData.info && newData.data) {
    updateOffscreenCanvas(newData)
  }
}, { deep: true })

onMounted(() => {
  if (props.mapData) updateOffscreenCanvas(props.mapData)
})
</script>

<style scoped>
.header-left {
  display: flex;
  align-items: center;
}
.btn-mini {
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.2);
  color: #fff;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.2s;
}
.btn-mini:hover {
  background: rgba(255, 255, 255, 0.2);
}
.map-card :deep(.card-body) {
  padding: 0;
  display: flex;
  flex-direction: column;
}
.map-canvas-container {
  width: 100%;
  flex: 1;
  min-height: 0;
  position: relative;
  overflow: hidden;
  background: #000;
  cursor: grab;
}
.map-canvas-container:active {
  cursor: grabbing;
}
canvas {
  display: block;
}
</style>
