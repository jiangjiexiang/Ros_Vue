export const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api'

const wsProtocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
export const DEFAULT_WS_URL = import.meta.env.VITE_FOXGLOVE_WS_URL || `${wsProtocol}://${window.location.hostname}:8765`
