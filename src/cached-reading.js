import {
  offlinePageRadius, readOfflineBook, readOfflinePage, saveOfflineBook,
  saveOfflinePage, setOfflineWindow,
} from './offline-library.js'

const pageAvailable = (page, total) => Number.isSafeInteger(page) && page >= 0 && page < total

function unavailableOffline(message) {
  return Object.assign(new Error(message), { code: 'OFFLINE_PAGE' })
}

export function createCachedReading({
  account, id, readBook, readPage, isOffline, isConnectionFailure, onConnectionFailure, onCacheChange,
}) {
  let preparation
  let windowQueue = Promise.resolve()
  let disposed = false

  function recoverFromConnectionFailure(error, signal) {
    signal?.throwIfAborted()
    if ([401, 403, 404].includes(error?.status) || !isConnectionFailure(error)) return false
    onConnectionFailure?.(error)
    return true
  }

  async function loadPage(page, signal) {
    signal?.throwIfAborted()
    if (!isOffline()) {
      try {
        return await readPage(page, signal)
      } catch (error) {
        if (!recoverFromConnectionFailure(error, signal)) throw error
      }
    }
    const content = await readOfflinePage(account, id, page)
    signal?.throwIfAborted()
    if (content) return content
    throw unavailableOffline(`A página ${page + 1} ainda não está disponível offline. Conecte-se para carregar.`)
  }

  function reading(book, initialPage, content) {
    const pages = new Array(book.pageCount)
    pages[initialPage] = content
    return { ...book, initialPage, pages, loadPage }
  }

  async function openOffline(requestedPage, signal, explicit) {
    const saved = await readOfflineBook(account, id)
    signal?.throwIfAborted()
    if (!saved?.cachedPages.length) {
      throw unavailableOffline('Este livro ainda não está disponível offline. Abra-o com conexão para preparar as páginas.')
    }
    const { cachedPages, nextHighlightOffset, ...book } = saved
    const desired = requestedPage ?? book.currentPage ?? 0
    const nearby = cachedPages.filter(page => pageAvailable(page, book.pageCount) && (!explicit || page === desired))
      .sort((left, right) => Math.abs(left - desired) - Math.abs(right - desired) || left - right)
    for (const initialPage of nearby) {
      const content = await readOfflinePage(account, id, initialPage)
      signal?.throwIfAborted()
      if (content) {
        return { ...reading(book, initialPage, content), offline: true, offlineFallback: initialPage !== desired }
      }
    }
    throw unavailableOffline(explicit
      ? `A página ${desired + 1} ainda não está disponível offline. Conecte-se para carregar.`
      : 'Nenhuma página deste livro está disponível offline. Abra-o com conexão para preparar as páginas.')
  }

  async function open(requestedPage, signal, { explicit = false } = {}) {
    signal?.throwIfAborted()
    if (!isOffline()) {
      try {
        const book = await readBook(signal)
        const desired = requestedPage ?? book.currentPage ?? 0
        const initialPage = pageAvailable(desired, book.pageCount) ? desired : 0
        const content = await readPage(initialPage, signal)
        signal?.throwIfAborted()
        const saved = await saveOfflineBook(account, id, book)
        signal?.throwIfAborted()
        if (saved) warm(initialPage, book.pageCount, content)
        return reading(book, initialPage, content)
      } catch (error) {
        if (!recoverFromConnectionFailure(error, signal)) throw error
      }
    }
    return openOffline(requestedPage, signal, explicit)
  }

  async function preparePage(page, signal) {
    if (signal.aborted || isOffline()) return
    const content = await readPage(page, signal)
    if (!signal.aborted) await saveOfflinePage(account, id, page, content)
  }

  function warm(page, total, content, { force = false } = {}) {
    if (disposed || !account || !pageAvailable(page, total)) return
    if (isOffline()) {
      preparation?.controller.abort()
      preparation = undefined
      return
    }
    if (!force && preparation?.page === page && preparation.total === total) return preparation.task
    preparation?.controller.abort()
    const controller = new AbortController()
    const { signal } = controller
    const current = { page, total, controller }
    preparation = current

    const windowReady = windowQueue.then(async () => {
      if (signal.aborted || isOffline() || !await setOfflineWindow(account, id, page)) return false
      if (signal.aborted) return false
      if (content) await saveOfflinePage(account, id, page, content)
      if (!signal.aborted) onCacheChange?.()
      return true
    })
    windowQueue = windowReady.catch(() => {})
    current.task = windowReady.then(async ready => {
      if (!ready) {
        if (preparation === current) preparation = undefined
        return
      }
      const nearby = content ? [] : [page]
      for (let distance = 1; distance <= offlinePageRadius; distance++) {
        nearby.push(page + distance, page - distance)
      }
      const record = await readOfflineBook(account, id)
      const cached = new Set(record?.cachedPages)
      const targets = nearby.filter(index => pageAvailable(index, total) && !cached.has(index))
      for (let index = 0; index < targets.length && !signal.aborted && !isOffline(); index += 2) {
        const results = await Promise.allSettled(targets.slice(index, index + 2).map(index => preparePage(index, signal)))
        if (results.some(result => result.status === 'rejected')) {
          if (preparation === current) preparation = undefined
          break
        }
      }
      if (!signal.aborted) onCacheChange?.()
    }).catch(() => {
      if (preparation === current) preparation = undefined
    })
    return current.task
  }

  function cleanup() {
    disposed = true
    preparation?.controller.abort()
    preparation = undefined
  }

  return { open, loadPage, warm, cleanup }
}
