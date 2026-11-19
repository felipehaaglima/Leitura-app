const syncing = new Map()

function prefix(account, id) {
  return `margem:leitura-pendente:${account}:${id}:`
}

function read(key) {
  try {
    return JSON.parse(localStorage.getItem(key))
  } catch {
    return null
  }
}

function highlightKeys(account, id) {
  const start = `${prefix(account, id)}destaque:`
  try {
    return Object.keys(localStorage).filter(key => key.startsWith(start))
  } catch {
    return []
  }
}

export function pendingReading(account, id) {
  const position = read(`${prefix(account, id)}posicao`)
  const highlights = highlightKeys(account, id).map(read).filter(Boolean)
  return { position, highlights }
}

export function savePendingPosition(account, id, page, anchor) {
  localStorage.setItem(`${prefix(account, id)}posicao`, JSON.stringify({ page, anchor }))
}

export function addPendingHighlight(account, id, data) {
  const highlight = { ...data, id: crypto.randomUUID() }
  localStorage.setItem(`${prefix(account, id)}destaque:${highlight.id}`, JSON.stringify(highlight))
  return highlight
}

export function removePendingHighlight(account, id, highlightId) {
  try {
    localStorage.removeItem(`${prefix(account, id)}destaque:${highlightId}`)
  } catch {
    // Removing a synced highlight does not require local storage.
  }
}

export function clearPendingReading(account, id) {
  try {
    localStorage.removeItem(`${prefix(account, id)}posicao`)
    for (const key of highlightKeys(account, id)) localStorage.removeItem(key)
  } catch {
    // A browser that disables local storage has no pending reading to clear.
  }
}

export function syncPendingReading(api, account, id) {
  const start = prefix(account, id)
  if (!syncing.has(start)) {
    const task = (async () => {
      const positionKey = `${start}posicao`
      const position = read(positionKey)
      if (position) {
        const before = JSON.stringify(position)
        await api(`/books/${id}/progress`, { method: 'PATCH', data: position })
        if (localStorage.getItem(positionKey) === before) localStorage.removeItem(positionKey)
      }
      for (const key of highlightKeys(account, id)) {
        const highlight = read(key)
        if (!highlight) continue
        const { id: markId, page, block, start, end, color } = highlight
        await api(`/books/${id}/highlights`, { method: 'POST', data: { id: markId, page, block, start, end, color } })
        localStorage.removeItem(key)
      }
    })().finally(() => syncing.delete(start))
    syncing.set(start, task)
  }
  return syncing.get(start)
}
