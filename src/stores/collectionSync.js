export function cloneCollection(items) {
  return JSON.parse(JSON.stringify(Array.isArray(items) ? items : []))
}

function stableStringify(value) {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
}

export function collectionsEqual(left, right) {
  return stableStringify(left) === stableStringify(right)
}

function itemId(item, index) {
  return item?.id === undefined || item?.id === null || item?.id === '' ? `__missing_${index}` : String(item.id)
}

function byId(items) {
  const result = new Map()
  items.forEach((item, index) => {
    result.set(itemId(item, index), item)
  })
  return result
}

export function mergeCollectionById(baseItems, localItems, serverItems) {
  const base = byId(baseItems)
  const local = byId(localItems)
  const server = byId(serverItems)
  const ids = new Set([...base.keys(), ...local.keys(), ...server.keys()])
  const mergedById = new Map()
  const localById = new Map()
  const conflicts = []

  for (const id of ids) {
    const baseItem = base.get(id)
    const localItem = local.get(id)
    const serverItem = server.get(id)
    const localChanged = !collectionsEqual(localItem, baseItem)
    const serverChanged = !collectionsEqual(serverItem, baseItem)
    const sameChange = collectionsEqual(localItem, serverItem)

    if (localChanged && serverChanged && !sameChange) {
      conflicts.push(id)
      if (serverItem !== undefined) mergedById.set(id, serverItem)
      if (localItem !== undefined) localById.set(id, localItem)
    } else if (localChanged && !serverChanged) {
      if (localItem !== undefined) {
        mergedById.set(id, localItem)
        localById.set(id, localItem)
      }
    } else {
      if (serverItem !== undefined) {
        mergedById.set(id, serverItem)
        localById.set(id, serverItem)
      }
    }
  }

  const orderItems = (itemsById) => {
    const ordered = []
    const added = new Set()
    for (const items of [serverItems, localItems]) {
      for (const [index, item] of items.entries()) {
        const id = itemId(item, index)
        if (added.has(id) || !itemsById.has(id)) continue
        ordered.push(itemsById.get(id))
        added.add(id)
      }
    }
    return ordered
  }

  return {
    items: orderItems(mergedById),
    localItems: orderItems(localById),
    conflicts
  }
}

export function collectionConflictError(label, conflicts) {
  const suffix = conflicts.length > 6 ? ` 等 ${conflicts.length} 项` : ''
  return new Error(`${label}与服务器同项冲突（${conflicts.slice(0, 6).join('、')}${suffix}）；本地修改已保留，请人工核对后重试`)
}
