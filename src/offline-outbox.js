const namespace = 'margem:leitura-offline:'
const syncing = new Map()
let latestOrder = 0

const routes = {
  position: () => ['/progress', 'PATCH'],
  'add-highlight': () => ['/highlights', 'POST', 'highlight'],
  'update-highlight': ({ markId }) => [`/highlights/${encodeURIComponent(markId)}`, 'PATCH', 'highlight'],
  'remove-highlight': ({ markId }) => [`/highlights/${encodeURIComponent(markId)}`, 'DELETE'],
  'add-note': ({ markId }) => [`/highlights/${encodeURIComponent(markId)}/notes`, 'POST', 'note'],
  'update-note': ({ markId, noteId }) => [`/highlights/${encodeURIComponent(markId)}/notes/${encodeURIComponent(noteId)}`, 'PATCH', 'note'],
  'remove-note': ({ markId, noteId }) => [`/highlights/${encodeURIComponent(markId)}/notes/${encodeURIComponent(noteId)}`, 'DELETE'],
}

function prefix(account, bookId) {
  return `${namespace}${account}:${bookId === undefined ? '' : `${bookId}:`}`
}

function storedKeys(start) {
  try {
    return Object.keys(localStorage).filter(key => key.startsWith(start))
  } catch {
    return []
  }
}

function readChange(key) {
  try {
    const raw = localStorage.getItem(key)
    const change = JSON.parse(raw)
    return change && Object.hasOwn(routes, change.kind) ? { key, raw, change } : null
  } catch {
    return null
  }
}

function orderedChanges(account, bookId) {
  if (!account) return []
  return storedKeys(prefix(account, bookId)).map(readChange).filter(Boolean)
    .sort((left, right) => left.change.order - right.change.order || left.key.localeCompare(right.key))
}

export function pendingReadingBooks(account) {
  if (!account) return []
  const start = prefix(account)
  return [...new Set(storedKeys(start).map(key => key.slice(start.length).split(':', 1)[0]))]
}

export function pendingSavedPosition(account, bookId) {
  return account ? readChange(`${prefix(account, bookId)}position`)?.change.data : undefined
}

export function applyPendingHighlights(account, bookId, highlights) {
  const visible = new Map(highlights.map(mark => [mark.id, mark]))
  for (const { change } of orderedChanges(account, bookId)) {
    if (change.kind === 'add-highlight') visible.set(change.data.id, change.value ?? change.data)
    if (change.kind === 'update-highlight' && visible.has(change.markId)) {
      visible.set(change.markId, { ...visible.get(change.markId), ...change.data, ...change.value })
    }
    if (change.kind === 'remove-highlight') visible.delete(change.markId)
  }
  return [...visible.values()]
}

export function applyPendingNotes(account, bookId, markId, notes) {
  const visible = new Map(notes.map(note => [note.id, note]))
  for (const { change } of orderedChanges(account, bookId)) {
    if (change.markId !== markId) continue
    if (change.kind === 'add-note') visible.set(change.data.id, change.value ?? change.data)
    if (change.kind === 'update-note') {
      const note = change.value ?? (visible.has(change.noteId) && { ...visible.get(change.noteId), ...change.data })
      if (note) visible.set(change.noteId, note)
    }
    if (change.kind === 'remove-note') visible.delete(change.noteId)
  }
  return [...visible.values()]
}

export function clearSavedReadingChanges(account, bookId) {
  if (!account) return
  try {
    for (const key of storedKeys(prefix(account, bookId))) localStorage.removeItem(key)
  } catch {
    // There is no removable queue when browser storage is unavailable.
  }
}

function canRetry(error) {
  return !error?.status || [401, 408, 425, 429].includes(error.status) || error.status >= 500
}

async function sendChange(api, account, bookId, change) {
  const [path, method, field] = routes[change.kind](change)
  try {
    const response = await api(`/books/${encodeURIComponent(bookId)}${path}`, {
      method, data: change.data, account, signal: AbortSignal.timeout?.(15_000),
    })
    const confirmed = field ? response?.[field] : response
    if (field ? !confirmed?.id : confirmed?.ok !== true) throw new Error('A sincronização não foi confirmada.')
    return confirmed
  } catch (error) {
    if (method !== 'DELETE' || error.status !== 404) throw error
    return { ok: true }
  }
}

async function replayChanges(api, account, bookId) {
  const outcomes = new Map()
  const failures = []
  let positionOutcome
  while (true) {
    const batch = orderedChanges(account, bookId)
    if (!batch.length) return { pending: false, failures, outcomes, positionOutcome }
    for (const { key, raw, change } of batch) {
      if (localStorage.getItem(key) !== raw) continue
      let outcome
      try {
        const value = await sendChange(api, account, bookId, change)
        outcome = { value }
      } catch (error) {
        if (canRetry(error)) return { pending: true, failures, outcomes, positionOutcome }
        outcome = { error }
        failures.push(error)
      }
      outcomes.set(change.id, outcome)
      if (change.kind === 'position') positionOutcome = outcome
      if (localStorage.getItem(key) === raw) localStorage.removeItem(key)
    }
  }
}

export function syncReadingChanges(api, account, bookId) {
  const lock = prefix(account, bookId)
  if (!syncing.has(lock)) {
    const replay = () => replayChanges(api, account, bookId)
    const run = globalThis.navigator?.locks ? globalThis.navigator.locks.request(lock, replay) : replay()
    syncing.set(lock, run.finally(() => syncing.delete(lock)))
  }
  return syncing.get(lock)
}

export async function saveReadingChange(api, account, bookId, change, {
  online = globalThis.navigator?.onLine !== false,
  defer = false,
} = {}) {
  if (!account) throw new Error('Entre em sua conta para salvar a leitura.')
  if (!Object.hasOwn(routes, change.kind)) throw new Error('Alteração de leitura inválida.')

  const id = crypto.randomUUID()
  const isPosition = change.kind === 'position'
  const key = `${prefix(account, bookId)}${isPosition ? 'position' : id}`
  latestOrder = Math.max(Date.now() * 1_000, latestOrder + 1)
  const record = { ...change, id, order: latestOrder }
  if (isPosition && record.data.readAt === undefined) {
    record.data = { ...record.data, readAt: new Date().toISOString() }
  }
  if (change.kind === 'add-highlight' || change.kind === 'add-note') {
    record.data = { ...record.data, id: record.data.id ?? record.value?.id ?? id }
  }
  try {
    localStorage.setItem(key, JSON.stringify(record))
  } catch {
    if (online && !orderedChanges(account, bookId).length) {
      return { synced: true, value: await sendChange(api, account, bookId, record) }
    }
    throw new Error('Não foi possível guardar a alteração neste dispositivo.')
  }

  const optimistic = record.value ?? record.data
  if (!online || defer) return { synced: false, value: optimistic }
  const { outcomes, positionOutcome } = await syncReadingChanges(api, account, bookId)
  const result = outcomes.get(id) ?? (isPosition && !readChange(key) ? positionOutcome : undefined)
  if (result?.error) throw result.error
  return { synced: Boolean(result), value: result?.value ?? optimistic }
}
