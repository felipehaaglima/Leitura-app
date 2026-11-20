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

export function pendingPreviewPosition(account, id) {
  return read(`${prefix(account, id)}posicao`)
}

export function pendingReading(account, id) {
  const position = pendingPreviewPosition(account, id)
  const highlights = highlightKeys(account, id).map(read).filter(Boolean)
  return { position, highlights }
}

export function savePendingPosition(account, id, page, anchor) {
  localStorage.setItem(`${prefix(account, id)}posicao`, JSON.stringify({ page, anchor, readAt: new Date().toISOString() }))
}

export function addPendingHighlight(account, id, data) {
  const highlight = { ...data, id: crypto.randomUUID() }
  localStorage.setItem(`${prefix(account, id)}destaque:${highlight.id}`, JSON.stringify(highlight))
  return highlight
}

export function updatePendingHighlight(account, id, highlightId, changes) {
  const key = `${prefix(account, id)}destaque:${highlightId}`
  const mark = read(key)
  if (!mark) throw new Error('Destaque não encontrado.')
  const highlight = { ...mark, ...changes }
  localStorage.setItem(key, JSON.stringify(highlight))
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
        const { id: markId, page, block, start, end, color, note, scope, notes = [] } = highlight
        const path = `/books/${id}/highlights`
        await api(path, { method: 'POST', data: { id: markId, page, block, start, end, color, note, scope } })
        for (const entry of notes) {
          const data = { id: entry.id, text: entry.text, scope: entry.scope, mentions: [] }
          await api(`${path}/${markId}/notes`, { method: 'POST', data })
        }
        if (localStorage.getItem(key) === JSON.stringify(highlight)) localStorage.removeItem(key)
      }
    })().finally(() => syncing.delete(start))
    syncing.set(start, task)
  }
  return syncing.get(start)
}
