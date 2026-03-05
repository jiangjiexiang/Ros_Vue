<template>
  <div class="card">
    <div class="card-header">
      摇杆控制
    </div>
    <div class="card-body joystick-container">
      <div class="joystick-canvas-wrapper">
        <canvas
          ref="canvasRef"
          :width="canvasSize"
          :height="canvasSize"
          @mousedown="onStart"
          @touchstart.prevent="onTouchStart"
        />
      </div>

      <div class="velocity-display">
        <div class="velocity-item">
          <span class="label">线速度 m/s</span>
          <span class="value">{{ linearDisplay }}</span>
        </div>
        <div class="velocity-item">
          <span class="label">角速度 rad/s</span>
          <span class="value">{{ angularDisplay }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'

const props = defineProps({
  connected: Boolean
})

const emit = defineEmits(['velocity-change'])

// ---- 配置 ----
const canvasSize = 220
const baseRadius = 90
const knobRadius = 30
const maxLinearSpeed = 0.5   // m/s
const maxAngularSpeed = 1.0  // rad/s
const sendRate = 100         // ms (10 Hz)

// ---- 状态 ----
const canvasRef = ref(null)
const knobX = ref(0) // 相对于中心的偏移 (-1 ~ 1)
const knobY = ref(0)
let isDragging = false
let animationId = null
let sendTimer = null

const linearDisplay = computed(() => (knobY.value * -maxLinearSpeed).toFixed(2))
const angularDisplay = computed(() => (knobX.value * -maxAngularSpeed).toFixed(2))

// ---- 绘制 ----
function draw() {
  const canvas = canvasRef.value
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  const cx = canvasSize / 2
  const cy = canvasSize / 2

  ctx.clearRect(0, 0, canvasSize, canvasSize)

  // 底座外圈
  const outerGrad = ctx.createRadialGradient(cx, cy, baseRadius - 20, cx, cy, baseRadius)
  outerGrad.addColorStop(0, 'rgba(99, 102, 241, 0.08)')
  outerGrad.addColorStop(1, 'rgba(99, 102, 241, 0.02)')
  ctx.beginPath()
  ctx.arc(cx, cy, baseRadius, 0, Math.PI * 2)
  ctx.fillStyle = outerGrad
  ctx.fill()
  ctx.strokeStyle = 'rgba(99, 102, 241, 0.25)'
  ctx.lineWidth = 2
  ctx.stroke()

  // 十字参考线
  ctx.strokeStyle = 'rgba(99, 102, 241, 0.1)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(cx, cy - baseRadius + 10)
  ctx.lineTo(cx, cy + baseRadius - 10)
  ctx.moveTo(cx - baseRadius + 10, cy)
  ctx.lineTo(cx + baseRadius - 10, cy)
  ctx.stroke()

  // 摇杆手柄
  const handleX = cx + knobX.value * (baseRadius - knobRadius)
  const handleY = cy + knobY.value * (baseRadius - knobRadius)

  // 手柄主体
  const knobGrad = ctx.createRadialGradient(
    handleX - 5, handleY - 5, 2,
    handleX, handleY, knobRadius
  )
  knobGrad.addColorStop(0, '#818cf8')
  knobGrad.addColorStop(0.7, '#6366f1')
  knobGrad.addColorStop(1, '#4f46e5')
  ctx.beginPath()
  ctx.arc(handleX, handleY, knobRadius, 0, Math.PI * 2)
  ctx.fillStyle = knobGrad
  ctx.fill()

  // 手柄高光
  ctx.beginPath()
  ctx.arc(handleX - 6, handleY - 6, knobRadius * 0.35, 0, Math.PI * 2)
  ctx.fillStyle = 'rgba(255, 255, 255, 0.25)'
  ctx.fill()

  // 活动时的发光效果
  if (isDragging) {
    ctx.beginPath()
    ctx.arc(handleX, handleY, knobRadius + 6, 0, Math.PI * 2)
    ctx.strokeStyle = 'rgba(99, 102, 241, 0.4)'
    ctx.lineWidth = 3
    ctx.stroke()
  }
}

// ---- 触摸/鼠标事件 ----
function getCanvasPos(event) {
  const canvas = canvasRef.value
  if (!canvas) return { dx: 0, dy: 0 }
  const rect = canvas.getBoundingClientRect()
  const cx = canvasSize / 2
  const cy = canvasSize / 2
  const scaleX = canvasSize / rect.width
  const scaleY = canvasSize / rect.height

  // 兼容鼠标和触摸事件
  const clientX = event.clientX || (event.touches ? event.touches[0].clientX : 0)
  const clientY = event.clientY || (event.touches ? event.touches[0].clientY : 0)

  const x = (clientX - rect.left) * scaleX
  const y = (clientY - rect.top) * scaleY

  // 归一化到 -1 ~ 1
  let dx = (x - cx) / (baseRadius - knobRadius)
  let dy = (y - cy) / (baseRadius - knobRadius)

  // 限制在圆内
  const dist = Math.sqrt(dx * dx + dy * dy)
  if (dist > 1) {
    dx /= dist
    dy /= dist
  }

  return { dx, dy }
}

function onStart(event) {
  isDragging = true
  const { dx, dy } = getCanvasPos(event)
  knobX.value = dx
  knobY.value = dy
  draw()
  
  // 注册全局监听，保证移出 Canvas 也能继续控制
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onEnd)
}

function onMove(event) {
  if (!isDragging) return
  const { dx, dy } = getCanvasPos(event)
  knobX.value = dx
  knobY.value = dy
  draw()
}

function onEnd() {
  isDragging = false
  window.removeEventListener('mousemove', onMove)
  window.removeEventListener('mouseup', onEnd)
  window.removeEventListener('touchmove', onTouchMove)
  window.removeEventListener('touchend', onEnd)
  // 弹簧回中动画
  animateReturn()
}

function onTouchStart(event) {
  isDragging = true
  const { dx, dy } = getCanvasPos(event.touches[0])
  knobX.value = dx
  knobY.value = dy
  draw()
  
  window.addEventListener('touchmove', onTouchMove, { passive: false })
  window.addEventListener('touchend', onEnd)
}

function onTouchMove(event) {
  if (!isDragging) return
  const { dx, dy } = getCanvasPos(event.touches[0])
  knobX.value = dx
  knobY.value = dy
  draw()
}

// ---- 回中动画 ----
function animateReturn() {
  const decay = 0.85
  function step() {
    knobX.value *= decay
    knobY.value *= decay

    if (Math.abs(knobX.value) < 0.01 && Math.abs(knobY.value) < 0.01) {
      knobX.value = 0
      knobY.value = 0
      draw()
      return
    }

    draw()
    animationId = requestAnimationFrame(step)
  }
  if (animationId) cancelAnimationFrame(animationId)
  step()
}

// ---- 定时发送速度指令 (10 Hz) ----
function startSendLoop() {
  if (sendTimer) return
  sendTimer = setInterval(() => {
    const linearX = knobY.value * -maxLinearSpeed
    const angularZ = knobX.value * -maxAngularSpeed
    emit('velocity-change', { linearX, angularZ })
  }, sendRate)
}

function stopSendLoop() {
  if (sendTimer) {
    clearInterval(sendTimer)
    sendTimer = null
  }
}

// 连接状态改变时启停发送循环
watch(() => props.connected, (val) => {
  if (val) startSendLoop()
  else stopSendLoop()
})

onMounted(() => {
  draw()
  if (props.connected) startSendLoop()
})

onUnmounted(() => {
  stopSendLoop()
  if (animationId) cancelAnimationFrame(animationId)
})
</script>
