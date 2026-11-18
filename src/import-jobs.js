const databaseName = 'margem-imports'
const maxFileBytes = 80 * 1024 * 1024
const leaseDuration = 120_000
let databasePromise

function openDatabase() {
  return databasePromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1)
    let blocked = false
    request.onupgradeneeded = () => {
      const db = request.result
      db.createObjectStore('jobs', { keyPath: 'accountId' })
      db.createObjectStore('pages', { keyPath: ['jobId', 'index'] })
        .createIndex('byJob', 'jobId')
      db.createObjectStore('leases', { keyPath: 'accountId' })
    }
    request.onsuccess = () => {
      const db = request.result
      if (blocked) {
        db.close()
        return
      }
      db.onversionchange = () => {
        db.close()
        databasePromise = undefined
      }
      resolve(db)
    }
    request.onerror = () => reject(request.error)
    request.onblocked = () => {
      blocked = true
      reject(new Error('O armazenamento local está ocupado.'))
    }
  }).catch(() => null)
}

function value(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function transact(db, stores, mode, run) {
  const transaction = db.transaction(stores, mode)
  const done = new Promise((resolve, reject) => {
    transaction.oncomplete = resolve
    transaction.onabort = () => reject(transaction.error || new Error('O armazenamento local foi interrompido.'))
  })
  done.catch(() => {})
  try {
    const result = await run(transaction)
    await done
    return result
  } catch (error) {
    try { transaction.abort() } catch { /* Already finished. */ }
    await done.catch(() => {})
    throw error
  }
}

const loadJob = (db, accountId) => transact(db, ['jobs'], 'readonly', transaction =>
  value(transaction.objectStore('jobs').get(accountId)))

async function saveJob(db, job, isNew = false) {
  return transact(db, ['jobs'], 'readwrite', async transaction => {
    const store = transaction.objectStore('jobs')
    if (isNew) return value(store.add(job))
    if ((await value(store.get(job.accountId)))?.id !== job.id) return
    return value(store.put(job))
  })
}

const storePage = (db, page) => transact(db, ['pages'], 'readwrite', transaction =>
  value(transaction.objectStore('pages').put(page)))

const loadPages = (db, jobId) => transact(db, ['pages'], 'readonly', transaction =>
  value(transaction.objectStore('pages').index('byJob').getAll(jobId)))

async function removeJob(db, accountId, id) {
  await transact(db, ['jobs', 'pages'], 'readwrite', async transaction => {
    const jobs = transaction.objectStore('jobs')
    const pages = transaction.objectStore('pages')
    if ((await value(jobs.get(accountId)))?.id !== id) return
    const pageKeys = await value(pages.index('byJob').getAllKeys(id))
    await Promise.all([value(jobs.delete(accountId)), ...pageKeys.map(key => value(pages.delete(key)))])
  })
}

function delay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted()
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', stop)
      resolve()
    }, milliseconds)
    function stop() {
      clearTimeout(timeout)
      reject(signal.reason)
    }
    signal.addEventListener('abort', stop, { once: true })
  })
}

function forwardAbort(signal, controller) {
  const stop = () => controller.abort(signal.reason)
  if (signal.aborted) stop()
  else signal.addEventListener('abort', stop, { once: true })
  return () => signal.removeEventListener('abort', stop)
}

async function changeLease(db, accountId, token, action) {
  return transact(db, ['leases'], 'readwrite', async transaction => {
    const store = transaction.objectStore('leases')
    const held = await value(store.get(accountId))
    if (action === 'release') {
      if (held?.token === token) await value(store.delete(accountId))
      return true
    }
    if (action === 'renew' && held?.token !== token) return false
    if (held?.token !== token && held?.expires > Date.now()) return false
    await value(store.put({ accountId, token, expires: Date.now() + leaseDuration }))
    return true
  })
}

async function withLock(db, accountId, signal, run) {
  signal.throwIfAborted()
  if (navigator.locks) {
    return navigator.locks.request(`${databaseName}:${accountId}`, { signal }, () => run(signal))
  }
  if (!db) return run(signal)

  const token = crypto.randomUUID()
  while (!await changeLease(db, accountId, token, 'claim')) await delay(1500, signal)
  const lease = new AbortController()
  const jobSignal = lease.signal
  const detach = forwardAbort(signal, lease)
  const heartbeat = setInterval(async () => {
    try {
      if (!await changeLease(db, accountId, token, 'renew')) lease.abort()
    } catch {
      lease.abort()
    }
  }, leaseDuration / 4)
  try {
    jobSignal.throwIfAborted()
    return await run(jobSignal)
  } finally {
    detach()
    clearInterval(heartbeat)
    await changeLease(db, accountId, token, 'release').catch(() => {})
  }
}

function isTransient(error) {
  const status = error?.status
  return error instanceof TypeError || [408, 425, 429].includes(status) ||
    (Number.isInteger(status) && status >= 500)
}

function resumeData(checkpoints) {
  const pages = []
  const fallbackPages = []
  for (const checkpoint of checkpoints) {
    if (checkpoint.index !== pages.length) break
    pages.push(checkpoint.page)
    if (checkpoint.fallback) fallbackPages.push(checkpoint.index + 1)
  }
  return { pages, fallbackPages, thumbnail: checkpoints[0]?.thumbnail ?? null }
}

export function createImportManager({ uploadBook, onChange, onComplete }) {
  const local = new Map()
  let channel
  try {
    channel = new BroadcastChannel(databaseName)
  } catch { /* Web Locks and storage still work without cross-tab notifications. */ }
  let context
  let current = null

  function publish(scope, updates) {
    if (context !== scope) return
    const next = updates && scope.job ? {
      id: scope.job.id,
      title: scope.job.title || scope.job.fileName,
      persistent: scope.persisted && !local.has(scope.accountId),
      percent: current?.id === scope.job.id ? current.percent : 0,
      error: null,
      ...updates,
    } : null
    if (next === current || (next && current && Object.keys(next).every(key => next[key] === current[key]))) return
    current = next
    onChange(current)
  }

  function notify(scope, result) {
    if (context !== scope) return
    Promise.resolve().then(() => {
      if (context === scope) return onComplete(result, scope.accountId)
    }).catch(error => console.error('Falha ao atualizar a biblioteca.', error))
  }

  function broadcast(type, scope, jobId, extra = {}) {
    if (scope.persisted) channel?.postMessage({ type, accountId: scope.accountId, jobId, ...extra })
  }

  function sendProgress(scope) {
    if (context !== scope || !scope.executing || !current) return
    const { id, status, phase, percent } = current
    broadcast('progress', scope, id, { status, phase, percent })
  }

  function progress(scope, updates) {
    publish(scope, { ...updates, percent: Math.max(current?.percent || 0, updates.percent || 0) })
    if (scope.progressTimer || !scope.persisted) return
    scope.progressTimer = setTimeout(() => {
      scope.progressTimer = null
      sendProgress(scope)
    }, 250)
  }

  function showFailure(scope) {
    const message = scope.job?.failure?.message
    if (!message) return
    publish(scope, { status: 'error', phase: 'Importação interrompida', error: message })
  }

  async function readScope(scope) {
    const db = await openDatabase()
    const saved = db && await loadJob(db, scope.accountId).catch(() => null)
    if (context !== scope) return
    scope.db = db
    const remembered = local.get(scope.accountId)
    scope.job = saved || remembered?.job
    scope.persisted = Boolean(saved)
    if (remembered && scope.job?.id !== remembered.job.id) local.delete(scope.accountId)
    if (scope.job?.failure?.retryOnSignIn) await clearFailure(scope).catch(() => {})
    if (context !== scope) return
    if (scope.job?.failure) showFailure(scope)
    else launch(scope)
  }

  async function processJob(scope, id, signal) {
    const cached = local.get(scope.accountId)
    if (scope.persisted) {
      const saved = await loadJob(scope.db, scope.accountId)
      if (saved?.id !== id) {
        if (scope.job?.id === id) {
          scope.job = null
          local.delete(scope.accountId)
          publish(scope, null)
        }
        return
      }
      scope.job = saved
    }
    signal.throwIfAborted()
    if (scope.job.failure) return showFailure(scope)

    const checkpoints = cached?.job.id === id ? cached.checkpoints :
      scope.persisted ? await loadPages(scope.db, id) : []
    const resume = resumeData(checkpoints)
    checkpoints.length = resume.pages.length
    let extractionTotal = checkpoints.at(-1)?.total || 0
    const { job } = scope
    const file = job.file.name === job.fileName ? job.file :
      new File([job.file], job.fileName, { type: job.file.type, lastModified: job.lastModified })

    progress(scope, {
      status: 'running', phase: 'Abrindo o PDF…',
      percent: extractionTotal ? Math.floor(85 * resume.pages.length / extractionTotal) : 0,
    })
    const { importPdf } = await import('./pdf.js')
    signal.throwIfAborted()
    const document = await importPdf(file, {
      signal,
      resume,
      onProgress({ stage, current: page, total, fraction = 0 }) {
        if (!total || signal.aborted) return
        extractionTotal = total
        const phase = stage === 'ocr' ? `Reconhecendo texto da página ${page} de ${total}…` :
          stage === 'complete' ? 'Preparando o envio…' : `Processando página ${page} de ${total}…`
        const percent = stage === 'complete' ? 85 : Math.floor(85 * (page - 1 + fraction) / total)
        progress(scope, { status: 'running', phase, percent })
      },
      async onPage({ index, page, thumbnail, fallback }) {
        signal.throwIfAborted()
        const checkpoint = { jobId: id, index, page, thumbnail, fallback, total: extractionTotal }
        checkpoints[index] = checkpoint
        if (scope.persisted && !local.has(scope.accountId)) {
          try {
            await storePage(scope.db, checkpoint)
            return
          } catch { /* Retain this session's progress if the browser cannot write more pages. */ }
        }
        local.set(scope.accountId, { job, checkpoints })
        progress(scope, { status: 'running', phase: current?.phase || 'Processando PDF…' })
      },
    })

    const payload = { title: job.title || document.title, pages: document.pages, thumbnail: document.thumbnail }
    let book
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted()
      progress(scope, { status: 'running', phase: 'Salvando na sua biblioteca…', percent: 85 })
      try {
        book = await uploadBook(payload, (sent, total) => {
          if (signal.aborted) return
          const phase = sent === total ? 'Concluindo a importação…' : 'Salvando na sua biblioteca…'
          progress(scope, { status: 'running', phase, percent: total ? 85 + Math.floor(14 * sent / total) : 85 })
        }, { id, signal, accountId: scope.accountId })
        break
      } catch (error) {
        signal.throwIfAborted()
        if (!isTransient(error) || attempt === 2) throw error
        progress(scope, { status: 'waiting', phase: 'Conexão instável. Tentando novamente…', percent: 85 })
        await delay(1000 * 3 ** attempt, signal)
      }
    }

    if (scope.persisted) await removeJob(scope.db, scope.accountId, id)
    if (local.get(scope.accountId)?.job.id === id) local.delete(scope.accountId)
    scope.job = null
    publish(scope, null)
    broadcast('complete', scope, id, { fallbackPages: document.fallbackPages })
    notify(scope, { id, book, fallbackPages: document.fallbackPages })
  }

  async function fail(scope, id, error) {
    if (scope.job?.id !== id) return
    const job = {
      ...scope.job,
      failure: {
        message: error?.message || 'Não foi possível importar o PDF.',
        retryOnConnect: isTransient(error),
        retryOnSignIn: [401, 403].includes(error?.status),
      },
    }
    scope.job = job
    const remembered = local.get(scope.accountId)
    if (remembered?.job.id === id) remembered.job = job
    if (scope.persisted) await saveJob(scope.db, job).catch(() => {})
    showFailure(scope)
  }

  function launch(scope) {
    if (!scope.job || scope.task || scope.discarding || scope.signal.aborted) return
    const { id } = scope.job
    const controller = new AbortController()
    const { signal } = controller
    const detach = forwardAbort(scope.signal, controller)
    scope.worker = controller
    publish(scope, { status: 'waiting', phase: 'Aguardando para processar…' })
    broadcast('watch', scope, id)
    let lostLease = false
    scope.task = withLock(scope.db, scope.accountId, signal, async jobSignal => {
      scope.executing = true
      try {
        await processJob(scope, id, jobSignal)
      } catch (error) {
        if (!jobSignal.aborted) await fail(scope, id, error)
      } finally {
        scope.executing = false
        lostLease = jobSignal.aborted && !signal.aborted
      }
    }).catch(async error => {
      if (!signal.aborted) await fail(scope, id, error)
    }).finally(() => {
      detach()
      scope.worker = null
      scope.task = null
      if (lostLease) launch(scope)
    })
  }

  if (channel) channel.onmessage = ({ data }) => {
    const scope = context
    if (!scope || data?.accountId !== scope.accountId) return
    if (data.type === 'cancel' && scope.job?.id === data.jobId) scope.worker?.abort()
    if (data.type === 'watch' && scope.job?.id === data.jobId) sendProgress(scope)
    if (data.type === 'progress' && scope.job?.id === data.jobId && !scope.executing && !scope.discarding) {
      publish(scope, { status: data.status, phase: data.phase, percent: data.percent })
    }
    if (data.type === 'complete' || data.type === 'discard') {
      if (scope.job?.id === data.jobId) {
        scope.worker?.abort()
        scope.job = null
        local.delete(scope.accountId)
        publish(scope, null)
      }
      if (data.type === 'complete') notify(scope, { id: data.jobId, book: null, fallbackPages: data.fallbackPages ?? [] })
    }
    if (data.type === 'start' && !scope.job && !scope.starting) {
      scope.loading = readScope(scope)
    }
  }

  async function clearFailure(scope) {
    if (!scope.job?.failure) return
    const job = { ...scope.job, failure: null }
    if (scope.persisted) await saveJob(scope.db, job)
    if (scope !== context || scope.job?.id !== job.id) return
    scope.job = job
    const cached = local.get(scope.accountId)
    if (cached?.job.id === job.id) cached.job = job
  }

  async function retry() {
    const scope = context
    if (!scope) return
    await scope.loading
    await scope.task
    if (scope !== context || !scope.job?.failure) return
    await clearFailure(scope)
    if (scope === context) launch(scope)
  }

  globalThis.addEventListener?.('online', () => {
    if (context?.job?.failure?.retryOnConnect) void retry().catch(() => {})
  })

  return {
    get current() { return current },

    setAccount(accountId) {
      if (context && context.accountId === accountId) return context.loading
      context?.controller.abort()
      const controller = new AbortController()
      context = accountId ? { accountId, controller, signal: controller.signal } : null
      publish(context, null)
      if (context) {
        context.loading = readScope(context)
        return context.loading
      }
    },

    async start(file, title = '') {
      const scope = context
      if (!scope) throw new Error('Entre na sua conta para importar um PDF.')
      if (!file?.size || file.size > maxFileBytes) throw new Error('Escolha um PDF de até 80 MB.')
      await scope.loading
      scope.signal.throwIfAborted()
      if (scope.job || scope.starting) throw new Error('Conclua ou descarte a importação atual antes de iniciar outra.')
      const job = {
        id: crypto.randomUUID(),
        accountId: scope.accountId,
        title: title.trim(),
        fileName: file.name,
        lastModified: file.lastModified,
        file,
        failure: null,
      }
      scope.starting = true
      try {
        let persisted = false
        if (scope.db) {
          try {
            await saveJob(scope.db, job, true)
            persisted = true
          } catch (error) {
            if (error.name === 'ConstraintError') {
              if (context === scope) scope.loading = readScope(scope)
              throw new Error('Já existe uma importação em andamento para esta conta.')
            }
          }
        }
        scope.persisted = persisted
        if (!persisted) local.set(scope.accountId, { job, checkpoints: [] })
        scope.signal.throwIfAborted()
        scope.job = job
        broadcast('start', scope, job.id)
        launch(scope)
        return current
      } finally {
        scope.starting = false
      }
    },

    retry,

    async discard() {
      const scope = context
      if (!scope) return
      await scope.loading
      if (scope !== context || !scope.job || scope.discarding) return
      const { id } = scope.job
      scope.discarding = true
      publish(scope, { status: 'waiting', phase: 'Descartando a importação…' })
      scope.worker?.abort()
      broadcast('cancel', scope, id)
      try {
        await scope.task
        await withLock(scope.db, scope.accountId, scope.signal, async () => {
          if (scope.persisted) await removeJob(scope.db, scope.accountId, id)
          if (local.get(scope.accountId)?.job.id === id) local.delete(scope.accountId)
          if (scope.job?.id === id) {
            scope.job = null
            publish(scope, null)
          }
          broadcast('discard', scope, id)
        })
      } catch (error) {
        if (!scope.signal.aborted) await fail(scope, id, new Error('Não foi possível descartar o PDF. Tente novamente.'))
        throw error
      } finally {
        scope.discarding = false
      }
    },
  }
}
