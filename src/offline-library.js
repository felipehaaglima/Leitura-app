export const offlinePageRadius = 2

const maxBooks = 3
const maxPageBytes = 24 * 1024 * 1024
const maxLibraryCoverBytes = 2 * 1024 * 1024
const maxBookNoteBytes = 768 * 1024
const accountKey = 'active'
const snapshotKey = 'snapshot'
const databaseName = 'margem-offline-library'
const bookFields = [
  'title', 'author', 'pageCount', 'currentPage', 'anchor', 'createdAt', 'updatedAt', 'readAt',
  'recommendedBy', 'highlightCount', 'highlights', 'nextHighlightOffset',
]
let openingDatabase

function database() {
  return openingDatabase ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1)
    request.onupgradeneeded = () => {
      const db = request.result
      db.createObjectStore('account')
      db.createObjectStore('books', { keyPath: ['accountId', 'bookId'] })
      db.createObjectStore('pages', { keyPath: ['accountId', 'bookId', 'page'] })
      db.createObjectStore('notes', { keyPath: ['accountId', 'bookId', 'markId'] })
        .createIndex('book', ['accountId', 'bookId'])
    }
    request.onsuccess = () => {
      const db = request.result
      db.onversionchange = () => { db.close(); openingDatabase = undefined }
      resolve(db)
    }
    request.onerror = () => reject(request.error)
    request.onblocked = () => {
      request.onsuccess = () => request.result.close()
      reject(new Error('O armazenamento offline está ocupado.'))
    }
  }).catch(() => {
    openingDatabase = undefined
    return null
  })
}

function value(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function transact(stores, mode, run, fallback = null) {
  const db = await database()
  if (!db) return fallback
  let transaction
  try {
    transaction = db.transaction(['account', ...stores], mode)
    const done = new Promise((resolve, reject) => {
      transaction.oncomplete = resolve
      transaction.onabort = () => reject(transaction.error)
    })
    done.catch(() => {})
    const result = await run(transaction)
    await done
    return result
  } catch {
    try { transaction?.abort() } catch { /* Already finished. */ }
    return fallback
  }
}

function accountSnapshot(transaction) {
  return value(transaction.objectStore('account').get(snapshotKey))
}

function withAccount(accountId, stores, mode, run, fallback = null) {
  if (!accountId) return Promise.resolve(fallback)
  return transact(stores, mode, async transaction => {
    if (await value(transaction.objectStore('account').get(accountKey)) !== accountId) return fallback
    return run(transaction)
  }, fallback)
}

const bookKey = ({ accountId, bookId }) => [accountId, bookId]
const newestBooks = books => books.sort((left, right) => right.touched - left.touched)
const pageIndexes = record => record.cached.map(({ page }) => page).sort((left, right) => left - right)
const touchedNow = () => performance.timeOrigin + performance.now()

async function listCachedBooks(transaction) {
  const books = await value(transaction.objectStore('books').getAll())
  return newestBooks(books).filter(record => record.cached.length).map(record => ({
    id: record.bookId, cachedPages: pageIndexes(record),
  }))
}

async function deleteCachedBook(transaction, record) {
  const key = bookKey(record)
  const pages = transaction.objectStore('pages')
  const notes = transaction.objectStore('notes')
  const noteKeys = await value(notes.index('book').getAllKeys(IDBKeyRange.only(key)))
  await Promise.all([
    value(transaction.objectStore('books').delete(key)),
    ...record.cached.map(({ page }) => value(pages.delete([...key, page]))),
    ...noteKeys.map(noteKey => value(notes.delete(noteKey))),
  ])
}

export function readOfflineAccount() {
  return transact(['books'], 'readonly', async transaction => {
    const record = await accountSnapshot(transaction)
    return record ? { ...record, offlineBooks: await listCachedBooks(transaction) } : null
  })
}

export function setOfflineAccount(user) {
  return transact(['books', 'pages', 'notes'], 'readwrite', async transaction => {
    const store = transaction.objectStore('account')
    const previous = await accountSnapshot(transaction)
    const active = user?.id ? { id: user.id, name: user.name, email: user.email } : null
    if (active && previous?.user.id === active.id) {
      await value(store.put({ ...previous, user: active }, snapshotKey))
      return true
    }
    await Promise.all(['account', 'books', 'pages', 'notes'].map(name => value(transaction.objectStore(name).clear())))
    if (active) await Promise.all([
      value(store.put(active.id, accountKey)),
      value(store.put({ user: active, books: [], palette: [], theme: 'classic' }, snapshotKey)),
    ])
    return true
  }, false)
}

function compactLibrary(books) {
  let remaining = maxLibraryCoverBytes
  return books.map(({ thumbnail, ...book }) => {
    const bytes = typeof thumbnail === 'string' ? 2 * thumbnail.length : 0
    if (!bytes || bytes > remaining) return book
    remaining -= bytes
    return { ...book, thumbnail }
  })
}

export function saveOfflineAccount(accountId, { books, palette, theme }) {
  const stores = books ? ['books', 'pages', 'notes'] : []
  return withAccount(accountId, stores, 'readwrite', async transaction => {
    const record = await accountSnapshot(transaction)
    if (books) {
      record.books = compactLibrary(books)
      const present = new Set(books.map(book => book.id))
      const cached = await value(transaction.objectStore('books').getAll())
      for (const book of cached) {
        if (!present.has(book.bookId)) await deleteCachedBook(transaction, book)
      }
    }
    if (palette !== undefined) record.palette = palette
    if (theme !== undefined) record.theme = theme
    await value(transaction.objectStore('account').put(record, snapshotKey))
    return true
  }, false)
}

export function listOfflineBooks(accountId) {
  return withAccount(accountId, ['books'], 'readonly', listCachedBooks, [])
}

export function readOfflineBook(accountId, bookId) {
  return withAccount(accountId, ['books'], 'readonly', async transaction => {
    const record = await value(transaction.objectStore('books').get([accountId, bookId]))
    return record ? { ...record.book, cachedPages: pageIndexes(record) } : null
  })
}

export function saveOfflineBook(accountId, bookId, patch) {
  const key = [accountId, bookId]
  return withAccount(accountId, ['books', 'pages', 'notes'], 'readwrite', async transaction => {
    const store = transaction.objectStore('books')
    const previous = await value(store.get(key))
    const record = previous ?? { accountId, bookId, book: { id: bookId }, touched: touchedNow(), cached: [] }
    for (const field of bookFields) {
      if (patch[field] !== undefined) record.book[field] = patch[field]
    }
    if (!previous && !Number.isSafeInteger(record.book.pageCount)) return false
    if (!previous) {
      const others = newestBooks(await value(store.getAll()))
      for (const stale of others.slice(maxBooks - 1)) await deleteCachedBook(transaction, stale)
    }
    await value(store.put(record))
    return true
  }, false)
}

export function removeOfflineBook(accountId, bookId) {
  return withAccount(accountId, ['books', 'pages', 'notes'], 'readwrite', async transaction => {
    const record = await value(transaction.objectStore('books').get([accountId, bookId]))
    if (record) await deleteCachedBook(transaction, record)
    const account = await accountSnapshot(transaction)
    account.books = account.books.filter(book => book.id !== bookId)
    await value(transaction.objectStore('account').put(account, snapshotKey))
    return true
  }, false)
}

export function setOfflineWindow(accountId, bookId, page) {
  return withAccount(accountId, ['books', 'pages'], 'readwrite', async transaction => {
    const store = transaction.objectStore('books')
    const key = [accountId, bookId]
    const record = await value(store.get(key))
    if (!record || !Number.isSafeInteger(page) || page < 0 || page >= record.book.pageCount) return false
    const pages = transaction.objectStore('pages')
    const stale = record.cached.filter(entry => Math.abs(entry.page - page) > offlinePageRadius)
    record.center = page
    record.touched = touchedNow()
    record.cached = record.cached.filter(entry => Math.abs(entry.page - page) <= offlinePageRadius)
    await Promise.all([value(store.put(record)), ...stale.map(entry => value(pages.delete([...key, entry.page])))])
    return true
  }, false)
}

export function readOfflinePage(accountId, bookId, page) {
  return withAccount(accountId, ['pages'], 'readonly', async transaction => {
    const cached = await value(transaction.objectStore('pages').get([accountId, bookId, page]))
    return cached?.content ?? null
  })
}

export function saveOfflinePage(accountId, bookId, page, content) {
  if (!Number.isSafeInteger(page) || page < 0 || !Array.isArray(content?.blocks)) return Promise.resolve(false)
  const bytes = 128 + content.blocks.reduce((size, block) => size + 128 + 2 * (
    (block?.src?.length ?? 0) + (block?.text?.length ?? 0) + (block?.alt?.length ?? 0)
  ), 0)
  if (bytes > maxPageBytes) return Promise.resolve(false)
  return withAccount(accountId, ['books', 'pages'], 'readwrite', async transaction => {
    const books = transaction.objectStore('books')
    const records = newestBooks(await value(books.getAll()))
    const record = records.find(book => book.bookId === bookId)
    const center = record?.center ?? record?.book.currentPage ?? page
    if (!record || page >= record.book.pageCount || Math.abs(page - center) > offlinePageRadius) return false
    if (record.cached.some(entry => entry.page === page)) return true

    const entry = { page, bytes }
    record.cached.push(entry)
    const candidates = records.flatMap(book => {
      const anchor = book.center ?? book.book.currentPage ?? 0
      const near = book.cached.slice().sort((left, right) =>
        Math.abs(left.page - anchor) - Math.abs(right.page - anchor) || right.page - left.page)
      return near.map(item => ({ book, item }))
    })
    const evictions = []
    let remaining = maxPageBytes
    for (const candidate of candidates) {
      if (candidate.item.bytes <= remaining) {
        remaining -= candidate.item.bytes
      } else {
        if (candidate.item === entry) return false
        evictions.push(candidate)
      }
    }

    const pages = transaction.objectStore('pages')
    const changed = new Set([record])
    for (const { book, item } of evictions) {
      book.cached = book.cached.filter(entry => entry.page !== item.page)
      changed.add(book)
      pages.delete([...bookKey(book), item.page])
    }
    pages.put({ accountId, bookId, page, content })
    await Promise.all([...changed].map(book => value(books.put(book))))
    return true
  }, false)
}

export function readOfflineNotes(accountId, bookId, markId) {
  return withAccount(accountId, ['notes'], 'readonly', async transaction => {
    const saved = await value(transaction.objectStore('notes').get([accountId, bookId, markId]))
    return saved?.notes ?? null
  })
}

export function saveOfflineNotes(accountId, bookId, markId, notes) {
  if (!Array.isArray(notes)) return Promise.resolve(false)
  const bytes = 2 * JSON.stringify(notes).length
  if (bytes > maxBookNoteBytes) return Promise.resolve(false)
  return withAccount(accountId, ['books', 'notes'], 'readwrite', async transaction => {
    const key = [accountId, bookId]
    if (!await value(transaction.objectStore('books').getKey(key))) return false
    const store = transaction.objectStore('notes')
    const saved = await value(store.index('book').getAll(IDBKeyRange.only(key)))
    const previous = saved.filter(record => record.markId !== markId).sort((left, right) => left.savedAt - right.savedAt)
    let total = previous.reduce((size, record) => size + record.bytes, bytes)
    for (const record of previous) {
      if (total <= maxBookNoteBytes) break
      total -= record.bytes
      store.delete([...key, record.markId])
    }
    await value(store.put({ accountId, bookId, markId, notes, bytes, savedAt: Date.now() }))
    return true
  }, false)
}
