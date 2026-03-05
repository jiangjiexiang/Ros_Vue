<template>
  <div class="card">
    <div class="card-header">
      底盘里程计 (Odom)
    </div>
    <div class="card-body">
      <div v-if="!odomData" class="empty-text">等待数据 (/odom)...</div>
      <div v-else class="telemetry-grid">
        <div class="data-group">
          <div class="data-label">位置 X</div>
          <div class="data-value">{{ odomData.pose.pose.position.x.toFixed(3) }} m</div>
        </div>
        <div class="data-group">
          <div class="data-label">位置 Y</div>
          <div class="data-value">{{ odomData.pose.pose.position.y.toFixed(3) }} m</div>
        </div>
        <div class="data-group">
          <div class="data-label">线速度</div>
          <div class="data-value">{{ odomData.twist.twist.linear.x.toFixed(3) }} m/s</div>
        </div>
        <div class="data-group">
          <div class="data-label">角速度</div>
          <div class="data-value">{{ odomData.twist.twist.angular.z.toFixed(3) }} rad/s</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
defineProps({
  odomData: Object
})
</script>

<style scoped>
.empty-text {
  color: var(--text-muted);
  font-size: 0.85rem;
  text-align: center;
  padding: 10px 0;
}
.telemetry-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.data-group {
  background: rgba(255, 255, 255, 0.05);
  padding: 8px;
  border-radius: var(--radius-sm);
  border: 1px solid rgba(255, 255, 255, 0.1);
  text-align: center;
}
.data-label {
  font-size: 0.7rem;
  color: var(--text-muted);
  margin-bottom: 4px;
}
.data-value {
  font-family: var(--font-mono);
  font-size: 0.95rem;
  color: var(--accent-primary);
  font-weight: 500;
}
</style>
