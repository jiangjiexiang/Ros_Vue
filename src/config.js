export const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api'

const API_TOKEN = String(import.meta.env.VITE_API_TOKEN || '').trim()

function isLoopback(hostname) {
  const normalized = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase()
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1'
}

export function apiFetch(input, options = {}) {
  if (!API_TOKEN) return globalThis.fetch(input, options)
  const pageUrl = new URL(window.location.href)
  const requestUrl = new URL(typeof input === 'string' ? input : input.url, pageUrl)
  const apiBaseUrl = new URL(API_BASE, pageUrl)
  const isSameOrigin = requestUrl.origin === pageUrl.origin
  const isApiBase = requestUrl.origin === apiBaseUrl.origin && requestUrl.pathname.startsWith(apiBaseUrl.pathname)
  if ((!isSameOrigin && !isApiBase) || isLoopback(requestUrl.hostname)) {
    return globalThis.fetch(input, options)
  }
  const headers = new Headers(options.headers || (typeof input === 'object' ? input.headers : undefined))
  if (!headers.has('Authorization')) headers.set('Authorization', `Bearer ${API_TOKEN}`)
  return globalThis.fetch(input, { ...options, headers })
}

const wsProtocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
export const DEFAULT_WS_URL = import.meta.env.VITE_FOXGLOVE_WS_URL || `${wsProtocol}://${window.location.hostname}:8765`
