import { API_BASE, apiFetch } from '../../config.js'

function normalizeApiMap(map, index) {
  const path = String(map.path || map.name || '')
  return {
    id: map.id || `api-map-${index}-${path}`,
    name: map.name || `地图 ${index + 1}`,
    path,
    source: 'api',
    isDemo: false,
    modifiedAt: map.modifiedAt || null,
    hasImage: map.hasImage !== false
  }
}

export async function loadMapScenes({ timeoutMs = 4000 } = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await apiFetch(`${API_BASE}/list_maps`, { signal: controller.signal })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const data = await response.json()
    if (!Array.isArray(data.maps)) throw new Error('地图接口未返回 maps 数组')
    return {
      maps: data.maps.map(normalizeApiMap).filter((map) => map.path),
      source: 'api',
      error: ''
    }
  } catch (error) {
    return {
      maps: [],
      source: 'api',
      error: `地图服务不可用（${error.name === 'AbortError' ? '请求超时' : error.message}）。`
    }
  } finally {
    clearTimeout(timeout)
  }
}
