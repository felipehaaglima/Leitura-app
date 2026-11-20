import './style.css'
import './pwa.js'
import { createCachedReading } from './cached-reading.js'
import { createImportManager } from './import-jobs.js'
import {
  listOfflineBooks, readOfflineAccount, readOfflineBook, readOfflineNotes, removeOfflineBook,
  saveOfflineAccount, saveOfflineBook, saveOfflineNotes, setOfflineAccount,
} from './offline-library.js'
import {
  applyPendingHighlights, applyPendingNotes, clearSavedReadingChanges, pendingReadingBooks,
  pendingSavedPosition, saveReadingChange, syncReadingChanges,
} from './offline-outbox.js'
import {
  addPendingHighlight, clearPendingReading, pendingPreviewPosition, pendingReading, removePendingHighlight,
  savePendingPosition, syncPendingReading, updatePendingHighlight,
} from './pending-reading.js'
import { normalizeReaderTheme } from './reader-themes.js'
import { deleteLocalNote, localHighlightNotes, writeLocalNote } from './reading-notes.js'
import { sampleBooks } from './samples.js'

const guestThemeKey = 'margem:reader-theme:guest'
const app = document.querySelector('#app')
const dialog = document.querySelector('#dialog')
const toast = document.querySelector('#toast')
const themeColor = document.querySelector('meta[name="theme-color"]')

const icons = {
  logo: '<path d="M5 4.75h6.2c1 0 1.8.42 2.8 1.42 1-1 1.8-1.42 2.8-1.42H21v13h-4.2c-1 0-1.8.42-2.8 1.42-1-1-1.8-1.42-2.8-1.42H5z"/><path d="M14 6.4v12.1M5 19.8h6.2c1 0 1.8.42 2.8 1.42 1-1 1.8-1.42 2.8-1.42H21"/>',
  library: '<path d="M4 19V5m4 14V5m4 14V5m4 1 4 13"/>',
  bookmark: '<path d="M6 5a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v15l-6-4-6 4z"/>',
  user: '<circle cx="12" cy="8" r="3"/><path d="M5 20v-2a4 4 0 0 1 4-4h6a4 4 0 0 1 4 4v2"/>',
  social: '<circle cx="9" cy="8" r="3"/><path d="M3 20v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2m2-15a3 3 0 0 1 0 6m5 9v-2a4 4 0 0 0-4-4"/>',
  upload: '<path d="M12 15V4m-4 4 4-4 4 4M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="m16 16 4 4"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  file: '<path d="M13 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10z"/><path d="M13 3v7h7M8 14h8m-8 3h6"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  external: '<path d="M13 5h6v6m0-6-9 9"/><path d="M19 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/>',
  trash: '<path d="M4 7h16m-14 0 1 13h10l1-13M9 7V4h6v3m-5 3v6m4-6v6"/>',
}
const icon = name => `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${icons[name]}</svg>`
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char])
const normalized = value => value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()

let user = null
let books = []
let booksVersion = 0
let highlightPalette = []
let offline = !navigator.onLine
let offlineBooks = new Map()
let sessionRevision = 0
let connecting
let reconnectTimer
let readingSync
let syncTimer
let themePreference = { account: null, theme: guestReaderTheme(), revision: 0, writeQueue: Promise.resolve() }
let section = 'library'
let filter = 'all'
let query = ''
let readerCleanup
let readerBook
let readerSession
let socialCleanup
let readerRequest = 0
let openingBook
let toastTimeout
const imports = createImportManager({
  uploadBook,
  onChange: updateImportProgress,
  onComplete: finishUpload,
})

function announce(message) {
  toast.textContent = message
  toast.hidden = false
  window.clearTimeout(toastTimeout)
  toastTimeout = window.setTimeout(() => { toast.hidden = true }, 4200)
}

async function api(path, { method = 'GET', data, signal, account } = {}) {
  if (account && user?.id !== account) {
    throw Object.assign(new Error('Entre na sua conta para continuar.'), { status: 401 })
  }
  const headers = new Headers()
  if (data !== undefined) headers.set('Content-Type', 'application/json')
  if (account) headers.set('X-Margem-Account', account)
  const response = await fetch(`/api${path}`, {
    method, signal, headers, body: data === undefined ? undefined : JSON.stringify(data),
  })
  const body = await response.json().catch(() => null)
  if (!response.ok || !body) {
    const error = new Error(body?.error || 'A biblioteca está indisponível. Tente novamente.')
    error.status = response.status
    throw error
  }
  return body
}

async function listAll(path, field, offset = 0, request = api) {
  const entries = []
  while (offset != null) {
    const page = await request(`${path}?offset=${offset}`)
    entries.push(...page[field])
    offset = page.nextOffset
  }
  return entries
}

const importPartSize = 500_000
const parallelParts = 4

async function transferParts(count, transfer, onProgress = () => {}) {
  const results = []
  for (let start = 0; start < count; start += parallelParts) {
    const batch = await Promise.allSettled(Array.from(
      { length: Math.min(parallelParts, count - start) },
      (_, index) => transfer(start + index),
    ))
    for (const result of batch) {
      if (result.status === 'rejected') throw result.reason
      results.push(result.value)
    }
    onProgress(results.length, count)
  }
  return results
}

async function uploadBook(document, onProgress, { id, accountId, signal }) {
  signal.throwIfAborted()
  const serialized = JSON.stringify(document)
  const parts = []
  for (let start = 0; start < serialized.length;) {
    let end = Math.min(start + importPartSize, serialized.length)
    const lastCodeUnit = serialized.charCodeAt(end - 1)
    if (lastCodeUnit >= 0xD800 && lastCodeUnit <= 0xDBFF) end--
    parts.push(serialized.slice(start, end))
    start = end
  }
  const session = await api('/imports', { method: 'POST', data: { id, accountId, partCount: parts.length }, signal })
  if (session.book) return session.book
  const received = new Set(session.receivedParts)
  const remaining = parts.map((_, index) => index).filter(index => !received.has(index))
  const path = `/imports/${id}`
  onProgress(received.size, parts.length)
  await transferParts(remaining.length, offset => api(`${path}/${remaining[offset]}`, {
    method: 'PUT', data: { chunk: parts[remaining[offset]] }, signal,
  }), sent => onProgress(received.size + sent, parts.length))
  return (await api(`${path}/complete`, { method: 'POST', signal })).book
}

function isConnectionFailure(error) {
  return error instanceof TypeError || error?.code === 'CONNECTION' || error?.name === 'TimeoutError' ||
    [502, 503, 504].includes(error?.status)
}

async function readRequest(path, signal, account) {
  signal?.throwIfAborted()
  const controller = new AbortController()
  const cancel = () => controller.abort(signal.reason)
  signal?.addEventListener('abort', cancel, { once: true })
  const timer = setTimeout(() => controller.abort(), 20_000)
  try {
    return await api(path, { signal: controller.signal, account })
  } catch (error) {
    signal?.throwIfAborted()
    if (controller.signal.aborted || error instanceof TypeError) {
      const message = controller.signal.aborted ? 'A resposta demorou demais.' : 'A conexão falhou.'
      throw Object.assign(new Error(message), { code: 'CONNECTION', cause: error })
    }
    throw error
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', cancel)
  }
}

function savedPageLoader(id, account) {
  return async (page, signal) => {
    const path = `/books/${id}/page?page=${page}`
    const { chunk, partCount } = await readRequest(path, signal, account)
    if (typeof chunk !== 'string' || !Number.isSafeInteger(partCount) || partCount < 1) {
      throw new Error('Não foi possível ler o conteúdo desta página.')
    }
    const remaining = await transferParts(partCount - 1, async index => (
      (await readRequest(`${path}&part=${index + 1}`, signal, account)).chunk
    ))
    let content
    try {
      content = JSON.parse([chunk, ...remaining].join(''))
    } catch {
      throw new Error('Não foi possível ler o conteúdo desta página.')
    }
    if (!Array.isArray(content?.blocks)) throw new Error('Não foi possível ler o conteúdo desta página.')
    return content
  }
}

function sampleState(book, account = user?.id) {
  try {
    return JSON.parse(localStorage.getItem(`margem:exemplo:${account ?? 'visitante'}:${book.id}`)) ?? { position: 0, highlights: [] }
  } catch {
    return { position: 0, highlights: [] }
  }
}

function storeSample(book, state, account) {
  localStorage.setItem(`margem:exemplo:${account ?? 'visitante'}:${book.id}`, JSON.stringify(state))
}

function demoSummary(book) {
  const state = sampleState(book)
  return { ...book, example: true, currentPage: state.position, pageCount: book.pages.length,
    highlightCount: state.highlights.length }
}

function bookCard(book) {
  const imported = !book.example
  const cover = imported && book.thumbnail
    ? `<img src="${escape(book.thumbnail)}" alt="" loading="lazy">`
    : `<div class="cover-text"><span>${escape(book.author || 'Documento pessoal')}</span><strong>${escape(book.title)}</strong></div>`
  return `<div class="book-tile${imported ? ' book-tile-owned' : ''}">
  <button class="book-card" type="button" data-book="${escape(book.id)}">
    <div class="book-cover ${imported ? 'cover-imported' : `cover-${book.id}`}">${cover}</div>
    <div class="book-caption">
      <h3>${escape(book.title)}</h3>
      <p>${book.recommendedBy?.name ? `Indicado por ${escape(book.recommendedBy.name)}` : escape(book.author ?? 'PDF importado')}</p>
      <span class="book-genre">${escape(book.genre ?? `${book.pageCount} páginas`)}</span>
      ${imported && offlineBooks.has(book.id) ? '<small class="book-offline">Páginas salvas offline</small>' : ''}
    </div>
    ${book.currentPage > 0 ? `<span class="book-progress" aria-label="Página ${book.currentPage + 1} de ${book.pageCount}"><span style="width: ${(book.currentPage + 1) / book.pageCount * 100}%"></span></span>` : ''}
  </button>
  ${imported ? `<button class="book-delete" type="button" data-delete-book="${escape(book.id)}" aria-label="Apagar ${escape(book.title)}" title="Apagar livro">${icon('trash')}</button>` : ''}
  </div>`
}

function libraryView() {
  return `<div class="page-content">
    <div class="page-intro">
      <h1>Sua biblioteca</h1>
      <p>Seus livros, suas leituras, seu ritmo.</p>
    </div>
    <section class="import-banner" aria-labelledby="import-heading">
      <div class="import-copy">
        <p class="banner-label">${icon('file')} LEITOR DE PDF</p>
        <h2 id="import-heading">Um novo lugar<br>para seus livros.</h2>
        <p>Importe um PDF e transforme suas páginas em uma leitura limpa e confortável.</p>
        <button class="button primary" type="button" data-action="upload">${icon('upload')} Importar PDF</button>
      </div>
      <div class="banner-art" aria-hidden="true"></div>
    </section>
    <section class="collection" aria-labelledby="collection-heading">
      <div class="collection-heading">
        <h2 id="collection-heading">Estante <span id="book-count"></span></h2>
        <label class="search-field">${icon('search')}<input type="search" id="search" aria-label="Buscar na biblioteca" placeholder="Buscar título ou autor" value="${escape(query)}"></label>
      </div>
      <div class="filters" aria-label="Filtrar livros">
        ${[['all','Todos'], ['pdf','Meus PDFs'], ['public','Acervo aberto']].map(([id,label]) => (
          `<button type="button" data-filter="${id}" aria-pressed="${filter === id}">${label}</button>`
        )).join('')}
      </div>
      <div id="book-list"></div>
    </section>
  </div>`
}

function renderBookList() {
  const list = document.querySelector('#book-list')
  if (!list) return
  const all = [
    ...(filter === 'public' ? [] : books),
    ...(filter === 'pdf' ? [] : sampleBooks.map(demoSummary)),
  ].filter(book => normalized(`${book.title} ${book.author ?? ''}`).includes(normalized(query.trim())))
  document.querySelector('#book-count').textContent = `${all.length} ${all.length === 1 ? 'título' : 'títulos'}`
  list.innerHTML = all.length
    ? `<div class="book-grid">${all.map(bookCard).join('')}</div>`
    : `<div class="empty">${icon(query ? 'search' : 'library')}<h3>${query ? 'Nenhum livro encontrado' : 'Sua estante de PDFs está vazia'}</h3>
      <p>${query ? 'Tente outro título ou autor.' : 'Importe seu primeiro PDF para começar a ler.'}</p>
      ${query ? '' : '<button class="button primary" type="button" data-action="upload">Importar PDF</button>'}</div>`
}

async function renderHighlights() {
  const results = document.querySelector('#highlight-results')
  try {
    const examples = sampleBooks.map(book => ({ ...book, highlights: sampleState(book).highlights }))
    const imported = new Map()
    if (user) {
      const account = user.id
      const sources = offline ? (await Promise.all([...offlineBooks.keys()].map(id => readOfflineBook(account, id)))).filter(Boolean)
        : await listAll('/highlights', 'books', 0, path => readRequest(path, undefined, account))
      for (const book of sources) {
        if (!imported.has(book.id)) imported.set(book.id, { ...book, highlights: [] })
        imported.get(book.id).highlights.push(...(book.highlights ?? []))
      }
      for (const book of imported.values()) book.highlights = applyPendingHighlights(account, book.id, book.highlights)
    }
    if (!results.isConnected) return
    const markedBooks = [...imported.values(), ...examples].filter(book => book.highlights.length)
    results.innerHTML = markedBooks.length
      ? markedBooks.map(book => `<section class="highlight-group"><h2>${escape(book.title)}</h2>${
        book.highlights.map(mark => `<button type="button" class="highlight-entry" data-book="${escape(book.id)}" data-highlight-id="${escape(mark.id)}" data-page="${mark.page}" data-block="${mark.block}" data-offset="${mark.start}">
          <span class="swatch swatch-${escape(mark.color || 'yellow')}"${/^#[0-9a-f]{6}$/i.test(mark.color) ? ` style="background-color:${mark.color}"` : ''}></span>
          <span><q>${escape(mark.text)}</q>${mark.note ? `<span class="highlight-note">${escape(mark.note)}</span>` : ''}<small>Página ${mark.page + 1}${mark.scope === 'group' ? ' · Grupo' : ''}</small></span>${icon('chevron')}
        </button>`).join('')
      }</section>`).join('')
      : `<div class="empty">${icon('bookmark')}<h3>Seus destaques aparecem aqui</h3><p>Selecione um trecho durante a leitura para guardá-lo.</p>
        <button class="button primary" type="button" data-section="library">Ver biblioteca</button></div>`
  } catch (error) {
    if (results.isConnected) results.textContent = error.message
  }
}

function renderShell() {
  themeColor?.setAttribute('content', '#f8f6ef')
  socialCleanup?.()
  socialCleanup = undefined
  readerCleanup?.()
  readerSession?.cache?.cleanup()
  readerCleanup = undefined
  readerBook = undefined
  readerSession = undefined
  document.title = 'Margem — Biblioteca de leitura'
  const active = name => section === name ? 'aria-current="page"' : ''
  const [sectionIcon, sectionName] = { library: ['library', 'Biblioteca'], highlights: ['bookmark', 'Destaques'], social: ['social', 'Social'] }[section]
  app.innerHTML = `<div class="shell">
    <aside class="sidebar">
      <button class="brand" type="button" data-section="library" aria-label="Margem — biblioteca">
        <span class="brand-mark">${icon('logo')}</span><span>margem<span class="brand-period">.</span></span>
      </button>
      <div class="sidebar-body">
        <span class="nav-title">MEU ESPAÇO</span>
        <nav aria-label="Navegação principal">
          <button type="button" data-section="library" ${active('library')}>${icon('library')} Biblioteca</button>
          <button type="button" data-section="highlights" ${active('highlights')}>${icon('bookmark')} Destaques</button>
          <button type="button" data-section="social" ${active('social')}>${icon('social')} Social</button>
        </nav>
      </div>
      <div class="sidebar-bottom">
        <button class="profile" type="button" data-action="account" aria-label="${user ? 'Gerenciar conta' : 'Entrar ou criar conta'}">
          <span class="avatar">${user ? escape(user.name.trim().charAt(0).toLocaleUpperCase('pt-BR')) : icon('user')}</span>
          <span><strong>${user ? escape(user.name) : 'Minha conta'}</strong>
          <small>${user ? 'Gerenciar conta' : 'Entrar ou criar conta'}</small></span>
          ${icon('chevron')}
        </button>
      </div>
    </aside>
    <main class="main-area">
      <header class="topbar"><p>${icon(sectionIcon)} ${sectionName}</p>
        <button class="button topbar-upload" type="button" data-action="upload">${icon('upload')} Importar PDF</button></header>
      <p class="offline-notice" role="status" ${offline ? '' : 'hidden'}>Sem conexão. Leia os livros com páginas salvas neste dispositivo.</p>
      <div id="import-summary" class="import-summary" hidden>
        <div class="import-summary-actions">
          <button type="button" class="import-summary-button" data-action="upload" aria-haspopup="dialog">
            <span class="import-summary-text"><strong data-import-state></strong><span data-import-title></span></span>
            <progress max="100" value="0" aria-hidden="true"></progress><strong class="import-summary-percent" data-import-percent></strong>
          </button>
          <button class="button secondary" type="button" data-action="read-import-preview" hidden>${icon('library')} Ler páginas disponíveis</button>
        </div>
      </div>
      ${section === 'library' ? libraryView() : section === 'social' ? '<div id="social-view"></div>' : `<div class="page-content highlights-page">
        <div class="page-intro"><h1>Seus destaques</h1><p>Volte aos trechos que você marcou.</p></div>
        <div id="highlight-results" aria-live="polite"><p>Carregando destaques…</p></div>
      </div>`}
    </main>
  </div>`
  updateImportProgress(imports.current)
  if (section === 'library') renderBookList()
  if (section === 'highlights') void renderHighlights()
  if (section === 'social') void mountSocial()
}

async function mountSocial() {
  const target = document.querySelector('#social-view')
  if (offline) {
    target.innerHTML = '<div class="page-content"><div class="page-intro"><h1>Social</h1><p>Conecte-se para acessar suas amizades e leituras em grupo.</p></div></div>'
    return
  }
  try {
    const { renderSocial } = await import('./social-view.js')
    if (target.isConnected) {
      socialCleanup = renderSocial(target, {
        user, api,
        onSignIn: () => showAuth(),
        onBook: (...args) => void openBook(...args),
        onLibraryChanged: refreshBooks,
      })
    }
  } catch (error) {
    if (target.isConnected) target.textContent = error.message
  }
}

function showDialog(title, contents, view = '') {
  dialog.dataset.view = view
  dialog.innerHTML = `<div class="modal-header"><h2 id="dialog-title">${escape(title)}</h2>
    <button type="button" class="icon-button" data-action="close-dialog" aria-label="Fechar">${icon('close')}</button></div>${contents}`
  if (!dialog.open) dialog.showModal()
}

function showAuth(mode = 'login', after) {
  if (offline || !navigator.onLine) return announce('Conecte-se para entrar na sua conta.')
  const register = mode === 'register'
  showDialog(register ? 'Crie sua conta' : 'Entre na Margem', `
    <p class="modal-description">Acesse sua biblioteca, seus destaques e seu progresso de leitura.</p>
    <form id="auth-form" class="modal-form">
      ${register ? '<label>Nome<input name="name" autocomplete="name" maxlength="100" required></label>' : ''}
      <label>E-mail<input type="email" name="email" autocomplete="email" maxlength="254" required></label>
      <label>Senha<input type="password" name="password" autocomplete="${register ? 'new-password' : 'current-password'}" ${register ? 'minlength="8"' : ''} maxlength="256" required></label>
      ${register ? '<p class="field-hint">Use pelo menos 8 caracteres.</p>' : ''}
      <p class="form-error" role="alert" hidden></p>
      <button class="button primary full-width" type="submit">${register ? 'Criar conta' : 'Entrar'}</button>
    </form>
    <p class="modal-switch">${register ? 'Já tem conta?' : 'Ainda não tem conta?'}
      <button type="button" id="switch-auth">${register ? 'Entrar' : 'Criar conta'}</button>
    </p>`)
  dialog.querySelector('#switch-auth').onclick = () => showAuth(register ? 'login' : 'register', after)
  dialog.querySelector('#auth-form').onsubmit = async event => {
    event.preventDefault()
    const form = event.currentTarget
    const submit = form.querySelector('[type=submit]')
    const error = form.querySelector('.form-error')
    submit.disabled = true
    error.hidden = true
    try {
      const data = Object.fromEntries(new FormData(form))
      const next = (await api(register ? '/register' : '/login', { method: 'POST', data })).user
      sessionRevision++
      await useSession(next, await readOfflineAccount(), { verified: true })
      void refreshPalette(next.id)
      void refreshReaderTheme(themePreference)
      try { await refreshBooks() } catch (failure) { announce(failure.message) }
      await setupImports()
      dialog.close()
      renderShell()
      scheduleReadingSync(0)
      after?.()
    } catch (failure) {
      error.hidden = false
      error.textContent = failure.message
    } finally {
      submit.disabled = false
    }
  }
}

function showAccount() {
  if (!user) return showAuth()
  showDialog('Minha conta', `<p class="account-name">${escape(user.name)}</p><p class="modal-description">${escape(user.email)}</p>
    <button class="button secondary" type="button" data-action="logout">Sair da conta</button>`)
}

function updateImportProgress(job) {
  const summary = document.querySelector('#import-summary')
  if (summary) summary.hidden = !job
  const watching = dialog.open && dialog.dataset.view === 'import-progress'
  if (!job) {
    if (watching) {
      dialog.querySelector('[data-import-message]').textContent = 'Importação encerrada.'
      dialog.querySelector('.import-meter').hidden = true
      dialog.querySelector('[data-import-storage]').hidden = true
      dialog.querySelector('[data-action="retry-import"]').hidden = true
      dialog.querySelector('[data-action="discard-import"]').hidden = true
      dialog.querySelector('[data-action="read-import-preview"]').hidden = true
    }
    return
  }

  if (summary) {
    const state = job.status === 'error' ? 'Importação pausada' : 'Importando PDF'
    summary.querySelector('[data-import-state]').textContent = state
    const title = summary.querySelector('[data-import-title]')
    title.textContent = job.title
    title.title = job.title
    summary.querySelector('[data-import-percent]').textContent = `${job.percent}%`
    summary.querySelector('progress').value = job.percent
    summary.querySelector('[data-action="read-import-preview"]').hidden = !job.loadedPages
  }

  if (readerSession?.preview && readerBook?.id === job.id) {
    const preview = imports.getPreview(job.id)
    if (preview) {
      readerSession.pages = preview.pages
      readerSession.pageCount = preview.pageCount
      readerBook = { ...readerBook, ...preview }
      readerCleanup?.updateBook(preview)
    }
  }

  if (!watching || dialog.dataset.importId !== job.id) return
  dialog.querySelector('.import-job-title').textContent = job.title
  dialog.querySelector('.import-meter progress').value = job.percent
  dialog.querySelector('.import-meter strong').textContent = `${job.percent}%`
  const message = dialog.querySelector('[data-import-message]')
  const nextMessage = job.status === 'error' ? job.error : job.phase || 'Preparando a importação…'
  if (message.textContent !== nextMessage) message.textContent = nextMessage
  dialog.querySelector('[data-import-storage]').hidden = job.persistent !== false
  dialog.querySelector('[data-action="retry-import"]').hidden = job.status !== 'error'
  dialog.querySelector('[data-action="discard-import"]').hidden = job.status !== 'error'
  dialog.querySelector('[data-action="read-import-preview"]').hidden = !job.loadedPages
}

function showImportProgress() {
  showDialog('Importação de PDF', `
    <div class="import-job">
      <p class="import-job-title"></p>
      <div class="import-meter"><progress max="100" value="0" aria-label="Progresso da importação"></progress><strong></strong></div>
      <p class="modal-description" data-import-message aria-live="polite"></p>
      <p class="field-hint" data-import-storage hidden>O navegador não conseguiu salvar o progresso. Mantenha esta aba aberta até terminar.</p>
      <div class="modal-actions">
        <button class="button secondary" type="button" data-action="close-dialog">Continuar navegando</button>
        <button class="button secondary" type="button" data-action="discard-import" hidden>Descartar</button>
        <button class="button primary" type="button" data-action="retry-import" hidden>Tentar novamente</button>
        <button class="button primary" type="button" data-action="read-import-preview" hidden>Ler páginas disponíveis</button>
      </div>
    </div>`, 'import-progress')
  dialog.dataset.importId = imports.current.id
  updateImportProgress(imports.current)
}

function showUpload() {
  if (imports.current) return showImportProgress()
  if (offline || !navigator.onLine) return announce('Conecte-se para importar um PDF.')
  if (!user) return showAuth('login', showUpload)
  showDialog('Importar PDF', `
    <p class="modal-description">O texto será extraído para o leitor. Para páginas escaneadas ou com caracteres ilegíveis, o app tenta reconhecer o texto em português e inglês.</p>
    <form id="upload-form" class="modal-form">
      <label class="file-drop">${icon('upload')}<strong>Escolha um arquivo PDF</strong><small>Até 80 MB e 500 páginas</small><input type="file" name="file" accept=".pdf,application/pdf" required></label>
      <label>Título opcional<input name="title" maxlength="240" placeholder="Usar o título do PDF"></label>
      <p class="form-error" role="alert" hidden></p>
      <button class="button primary full-width" type="submit">${icon('upload')} Importar e preparar leitura</button>
    </form>`)
  dialog.querySelector('#upload-form').onsubmit = async event => {
    event.preventDefault()
    const form = event.currentTarget
    const { file, title } = Object.fromEntries(new FormData(form))
    const submit = form.querySelector('[type=submit]')
    const error = form.querySelector('.form-error')
    submit.disabled = true
    error.hidden = true
    try {
      await imports.start(file, title.trim())
      if (dialog.open && dialog.contains(form) && imports.current) showImportProgress()
    } catch (failure) {
      if (form.isConnected && dialog.open) {
        error.hidden = false
        error.textContent = failure.message
      } else {
        announce(failure.message)
      }
    } finally {
      submit.disabled = false
    }
  }
}

async function setupImports() {
  try {
    await imports.setAccount(user?.id ?? null, { savedBooks: books })
  } catch (error) {
    announce(error.message)
  }
}

async function refreshOfflineBooks(account) {
  const entries = await listOfflineBooks(account)
  if (user?.id !== account) return
  const next = new Map(entries.map(book => [book.id, book.cachedPages]))
  const changed = next.size !== offlineBooks.size || [...next].some(([id]) => !offlineBooks.has(id))
  offlineBooks = next
  if (changed) renderBookList()
}

function setOffline(value) {
  if (offline === value) return
  offline = value
  const notice = document.querySelector('.offline-notice')
  if (notice) notice.hidden = !offline
  readerCleanup?.updateBook({ offline })
  if (!readerBook && section === 'social') {
    socialCleanup?.()
    socialCleanup = undefined
    void mountSocial()
  }
  if (!readerBook && section === 'highlights') void renderHighlights()
  if (offline) retryConnection()
}

function retryConnection() {
  clearTimeout(reconnectTimer)
  if (navigator.onLine && document.visibilityState !== 'hidden') {
    reconnectTimer = setTimeout(() => void reconnect(), 15_000)
  }
}

async function useSession(next, cached, { verified = false, revision = sessionRevision } = {}) {
  if (revision !== sessionRevision) return
  if (verified) await setOfflineAccount(next)
  if (revision !== sessionRevision) return
  const switched = user?.id !== next?.id
  user = next
  if (!switched) return
  const snapshot = next && cached?.user?.id === next.id ? cached : null
  setBooks(snapshot ? withPendingProgress(next.id, snapshot.books) : [], { cache: false })
  offlineBooks = new Map((snapshot?.offlineBooks ?? []).map(book => [book.id, book.cachedPages]))
  highlightPalette = snapshot?.palette ?? []
  if (readerBook || openingBook) {
    readerRequest++
    openingBook?.abort()
    renderShell()
  }
  setThemeAccount(next?.id ?? null, snapshot?.theme)
}

function accountReadingApi(account) {
  return (path, options = {}) => api(path, { ...options, account, signal: options.signal ?? AbortSignal.timeout?.(15_000) })
}

function scheduleReadingSync(delay = 350) {
  clearTimeout(syncTimer)
  if (!offline && navigator.onLine && user) syncTimer = setTimeout(() => void syncAccountReading(user.id), delay)
}

async function syncAccountReading(account) {
  if (readingSync?.account === account) return readingSync.task
  const task = (async () => {
    const request = accountReadingApi(account)
    const ids = pendingReadingBooks(account)
    const progress = new Map()
    let pending = false
    let failure
    for (const id of ids) {
      if (user?.id !== account || offline || !navigator.onLine) return
      try {
        await syncPendingReading(request, account, id)
        const result = await syncReadingChanges(request, account, id)
        pending ||= result.pending
        failure ||= result.failures[0]
        const saved = result.positionOutcome?.value
        if (Number.isInteger(saved?.page) && !pendingSavedPosition(account, id)) {
          progress.set(id, { currentPage: saved.page, anchor: saved.anchor, readAt: saved.readAt })
        }
      } catch (error) {
        if (isConnectionFailure(error)) {
          setOffline(true)
          return
        }
        pending = true
      }
    }
    if (user?.id !== account) return
    if (progress.size) {
      for (const [id, data] of progress) {
        if (pendingSavedPosition(account, id)) continue
        void saveOfflineBook(account, id, data)
      }
      setBooks(withPendingProgress(account, books.map(book => progress.has(book.id) ? { ...book, ...progress.get(book.id) } : book)))
      renderBookList()
    }
    if (failure) announce(failure.message ?? 'Algumas alterações não puderam ser sincronizadas.')
    if (ids.length && !pending) await refreshVisibleLibrary()
    if (pending || pendingReadingBooks(account).length) retryConnection()
  })().catch(error => {
    if (isConnectionFailure(error)) setOffline(true)
    else announce(error.message)
  }).finally(() => {
    if (readingSync?.task === task) readingSync = undefined
  })
  readingSync = { account, task }
  return task
}

function reconnect({ initial = false } = {}) {
  if (connecting) return connecting
  const revision = sessionRevision
  const task = (async () => {
    const cached = await readOfflineAccount()
    let verified = false
    try {
      if (!navigator.onLine) throw Object.assign(new Error('Sem conexão.'), { code: 'CONNECTION' })
      const { user: next } = await readRequest('/session')
      if (revision !== sessionRevision) return
      verified = true
      const changed = user?.id !== next?.id
      await useSession(next, cached, { verified: true, revision })
      if (revision !== sessionRevision) return
      setOffline(false)
      if (next) {
        await syncAccountReading(next.id)
        if (!offline) {
          void refreshPalette(next.id)
          void refreshReaderTheme(themePreference)
          await refreshBooks()
          readerSession?.warm?.(true)
        }
      }
      if (initial || changed) await setupImports()
      if (!readerBook && (initial || changed)) renderShell()
      else if (!readerBook && section === 'library') renderBookList()
    } catch (error) {
      if (revision !== sessionRevision) return
      if (!isConnectionFailure(error)) return announce(error.message)
      setOffline(true)
      if (initial && !verified) {
        await useSession(cached?.user ?? null, cached, { revision })
        await setupImports()
      }
      if (initial && !readerBook) renderShell()
      retryConnection()
    }
  })().finally(() => {
    if (connecting === task) connecting = undefined
  })
  connecting = task
  return task
}

function finishUpload({ id, book, fallbackPages }, accountId) {
  if (user?.id !== accountId) return
  const completedId = id ?? book?.id
  const liveReader = readerBook?.id === completedId && readerSession?.preview ? readerSession : null
  if (liveReader) liveReader.preview = false
  const draft = pendingReading(accountId, completedId)
  const sync = syncPendingReading(accountReadingApi(accountId), accountId, completedId).catch(error => announce(error.message))
  if (book) {
    setBooks([book, ...books.filter(item => item.id !== book.id)])
    renderBookList()
  }
  if (liveReader && readerSession === liveReader) {
    const item = book ?? books.find(item => item.id === completedId)
    liveReader.cache = cachedBook(accountId, completedId)
    const patch = {
      loadPage: liveReader.cache.loadPage,
      pageCount: item?.pageCount ?? readerBook.pageCount,
      title: item?.title ?? readerBook.title,
      loading: null,
    }
    liveReader.pageCount = patch.pageCount
    readerBook = { ...readerBook, ...patch }
    readerCleanup?.updateBook(patch)
    void saveOfflineBook(accountId, completedId, {
      ...item, title: readerBook.title, pageCount: liveReader.pageCount,
      currentPage: liveReader.page, anchor: draft.position?.anchor, highlights: [...liveReader.highlights.values()],
    }).then(() => liveReader.warm())
  }
  if (!book || draft.position || draft.highlights.length) {
    const ready = book ? sync : Promise.resolve()
    void ready.then(async () => {
      if (user?.id !== accountId) return
      await refreshBooks()
      renderBookList()
    }).catch(error => announce(error.message))
  }
  const count = fallbackPages?.length ?? 0
  const message = count
    ? `PDF adicionado. ${count === 1 ? 'Uma página foi preservada como imagem.' : `${count} páginas foram preservadas como imagens.`}`
    : 'PDF adicionado à biblioteca.'
  if (dialog.open && dialog.dataset.view === 'import-progress' && dialog.dataset.importId === completedId) {
    showDialog('Importação concluída', `
      <p class="modal-description">${escape(message)}</p>
      <div class="modal-actions">
        <button class="button secondary" type="button" data-action="close-dialog">Fechar</button>
        ${completedId ? `<button class="button primary" type="button" data-action="read-import" data-book="${escape(completedId)}">Ler agora</button>` : ''}
      </div>`)
  } else {
    announce(message)
  }
}

function showDeleteBook(id) {
  const book = books.find(item => item.id === id)
  if (!user || !book) return
  if (offline || !navigator.onLine) return announce('Conecte-se para apagar um livro da biblioteca.')
  const account = user.id
  readerRequest++
  showDialog('Apagar livro?', `
    <p class="modal-description"><strong>${escape(book.title)}</strong> será removido da sua biblioteca, junto com o progresso e os destaques dele.</p>
    <form id="delete-book-form" class="modal-form">
      <p class="form-error" role="alert" hidden></p>
      <div class="modal-actions">
        <button class="button secondary" type="button" data-action="close-dialog" autofocus>Cancelar</button>
        <button class="button danger" type="submit">${icon('trash')} Apagar livro</button>
      </div>
    </form>`)
  dialog.querySelector('#delete-book-form').onsubmit = async event => {
    event.preventDefault()
    const form = event.currentTarget
    const submit = form.querySelector('[type=submit]')
    const error = form.querySelector('.form-error')
    submit.disabled = true
    error.hidden = true
    try {
      await api(`/books/${id}`, { method: 'DELETE', account }).catch(failure => {
        if (failure.status !== 404) throw failure
      })
      setBooks(books.filter(item => item.id !== id))
      clearPendingReading(account, id)
      clearSavedReadingChanges(account, id)
      await removeOfflineBook(account, id)
      offlineBooks.delete(id)
      if (dialog.open && dialog.contains(form)) dialog.close()
      renderBookList()
      announce('Livro apagado da biblioteca.')
    } catch (failure) {
      if (dialog.open && dialog.contains(form)) {
        error.hidden = false
        error.textContent = failure.message
      } else {
        announce(failure.message)
      }
    } finally {
      submit.disabled = false
    }
  }
}

function setBooks(result, { cache = true } = {}) {
  booksVersion++
  books = result
  if (cache && user) void saveOfflineAccount(user.id, { books })
}

function withPendingProgress(account, entries) {
  return entries.map(book => {
    const pending = pendingSavedPosition(account, book.id) ?? pendingPreviewPosition(account, book.id)
    return pending ? { ...book, currentPage: pending.page, anchor: pending.anchor, readAt: pending.readAt } : book
  })
}

async function refreshBooks() {
  const account = user?.id
  if (offline || !account) return
  const version = ++booksVersion
  const result = await listAll('/books', 'books', 0, path => readRequest(path, undefined, account))
  if (account !== user?.id || version !== booksVersion) return
  setBooks(withPendingProgress(account, result))
  for (const book of books) {
    if (offlineBooks.has(book.id)) {
      const { currentPage, anchor, readAt } = book
      void saveOfflineBook(account, book.id, { currentPage, anchor, readAt })
    }
  }
  void refreshOfflineBooks(account)
}

async function refreshVisibleLibrary() {
  if (!user || readerBook || section !== 'library' || !document.querySelector('#book-list')) return
  try {
    await refreshBooks()
    renderBookList()
  } catch (error) {
    if (isConnectionFailure(error)) setOffline(true)
    else if (section === 'library' && !readerBook) announce(error.message)
  }
}

async function refreshPalette(account) {
  try {
    const { colors } = await readRequest('/reader/colors', undefined, account)
    if (user?.id === account) {
      highlightPalette = [...new Set([...colors, ...highlightPalette])]
      void saveOfflineAccount(account, { palette: highlightPalette })
      readerCleanup?.updateBook({ palette: highlightPalette })
    }
  } catch {
    // The preset colors remain available while the account palette is unavailable.
  }
}

function guestReaderTheme() {
  try {
    return normalizeReaderTheme(localStorage.getItem(guestThemeKey))
  } catch {
    return 'classic'
  }
}

function setThemeAccount(account, cachedTheme) {
  const preference = { account, theme: account ? normalizeReaderTheme(cachedTheme) : guestReaderTheme(), revision: 0, writeQueue: Promise.resolve() }
  themePreference = preference
  readerCleanup?.updateBook({ theme: preference.theme })
}

async function refreshReaderTheme(preference) {
  const revision = preference.revision
  try {
    const { theme } = await readRequest('/reader/theme', undefined, preference.account)
    if (themePreference !== preference || revision !== preference.revision) return
    preference.theme = normalizeReaderTheme(theme)
    void saveOfflineAccount(preference.account, { theme: preference.theme })
    readerCleanup?.updateBook({ theme: preference.theme })
  } catch {
    // The reader stays usable with its current theme if the preference cannot be loaded.
  }
}

function saveReaderTheme(preference, theme, session) {
  const pending = preference.writeQueue.then(async () => {
    if (themePreference !== preference) throw new Error('Abra o leitor novamente para alterar o tema.')
    let savedTheme = normalizeReaderTheme(theme)
    if (preference.account) {
      if (offline) throw new Error('Conecte-se para alterar o tema da sua conta.')
      const saved = await api('/reader/theme', { method: 'PUT', data: { theme: savedTheme }, account: preference.account })
      savedTheme = normalizeReaderTheme(saved.theme)
      void saveOfflineAccount(preference.account, { theme: savedTheme })
    } else {
      try {
        localStorage.setItem(guestThemeKey, savedTheme)
      } catch {
        throw new Error('Não foi possível salvar o tema neste navegador.')
      }
    }
    if (themePreference === preference) {
      preference.theme = savedTheme
      preference.revision++
      if (readerSession !== session) readerCleanup?.updateBook({ theme: savedTheme })
    }
    return savedTheme
  })
  preference.writeQueue = pending.catch(() => {})
  return pending
}

function routedBook() {
  return /^#livro=([a-z0-9-]{1,64})$/i.exec(window.location.hash)?.[1]
}

function recordReaderRoute(id) {
  const url = new URL(window.location.href)
  if (routedBook() && !history.state?.margemBook) {
    url.hash = ''
    history.replaceState(null, '', url)
  }
  if (history.state?.margemBook === id) return
  url.hash = `livro=${id}`
  if (history.state?.margemBook) history.replaceState({ margemBook: id }, '', url)
  else history.pushState({ margemBook: id }, '', url)
}

function showLibraryHome() {
  readerRequest++
  openingBook?.abort()
  if (dialog.open) dialog.close()
  section = 'library'
  renderShell()
  void refreshVisibleLibrary()
  window.scrollTo(0, 0)
}

function exitReader() {
  if (history.state?.margemBook && routedBook()) history.back()
  else showLibraryHome()
}

function openCurrentRoute() {
  const id = routedBook()
  if (!id) return
  if (user || sampleBooks.some(book => book.id === id)) void openBook(id)
  else showAuth('login', () => { if (routedBook() === id) void openBook(id) })
}

async function loadReadingGroup(account, id, page, signal) {
  const path = `/social/books/${id}/group?page=${page}`
  const group = await readRequest(path, signal, account)
  let offset = group.nextOffset
  while (offset != null) {
    const batch = await readRequest(`${path}&offset=${offset}`, signal, account)
    if (batch.status !== 'active') return batch
    group.highlights.push(...batch.highlights)
    offset = batch.nextOffset
  }
  return group
}

function readAvailablePages() {
  const job = imports.current
  if (!job?.loadedPages) return
  if (dialog.open) dialog.close()
  void openBook(job.id)
}

function cachedBook(account, id) {
  return createCachedReading({
    id, account,
    readBook: async signal => (await readRequest(`/books/${id}?metadata=1&paged=1`, signal, account)).book,
    readPage: savedPageLoader(id, account),
    isOffline: () => offline || !navigator.onLine,
    isConnectionFailure,
    onConnectionFailure: () => { if (user?.id === account) setOffline(true) },
    onCacheChange: () => void refreshOfflineBooks(account),
  })
}

function showOpeningBook(title) {
  showDialog('Abrindo livro', `
    <p class="modal-description">${escape(title)}</p>
    <progress class="opening-book-progress" aria-label="Carregando a página de leitura"></progress>
    <div class="modal-actions"><button class="button secondary" type="button" data-action="close-dialog">Cancelar</button></div>`,
  'open-book')
}

function showOpenFailure(error, retry, reload) {
  showDialog('Não foi possível abrir o livro', `
    <p class="modal-description" role="alert">${escape(error.message)}</p>
    <div class="modal-actions">
      <button class="button secondary" type="button" data-action="close-dialog">Fechar</button>
      <button class="button primary" type="button" id="retry-open-book">${reload ? 'Atualizar página' : 'Tentar novamente'}</button>
    </div>`, 'open-book-error')
  dialog.querySelector('#retry-open-book').onclick = reload ? () => window.location.reload() : async () => {
    if (error.code === 'OFFLINE_PAGE' && offline && navigator.onLine) await reconnect()
    retry()
  }
}

async function openBook(id, explicitPage, explicitAnchor, initialHighlightId) {
  const request = ++readerRequest
  const account = user?.id
  const sample = sampleBooks.find(book => book.id === id)
  const saved = books.find(book => book.id === id)
  const preview = saved ? null : imports.getPreview(id)
  if (preview && !preview.pages.length) return showImportProgress()
  openingBook?.abort()
  const controller = new AbortController()
  openingBook = controller
  const { signal } = controller
  const pending = sample ? null : pendingReading(account, id)
  const queuedPosition = sample ? null : pendingSavedPosition(account, id) ?? pending.position
  const requestedPage = explicitPage ?? queuedPosition?.page
  const title = sample?.title ?? saved?.title ?? preview?.title ?? 'Carregando a página de leitura…'
  if (!sample && !preview) showOpeningBook(title)
  let moduleFailed = false
  let cache = !sample && !preview ? cachedBook(account, id) : null
  let mounted = false
  const openSaved = () => cache.open(requestedPage, signal, { explicit: explicitPage !== undefined })
  const active = () => request === readerRequest && user?.id === account && !signal.aborted
  try {
    const [initial, reader] = await Promise.all([
      sample ?? preview ?? openSaved(),
      import('./reader.js').catch(() => {
        moduleFailed = true
        throw new Error('Atualize a página para carregar o leitor.')
      }),
    ])
    if (!active()) return
    let book = preview ? imports.getPreview(id) : initial
    if (!book) {
      showOpeningBook(title)
      cache = cachedBook(account, id)
      book = await openSaved()
    }
    if (!active()) return
    const sampleProgress = sample ? sampleState(sample, account) : null
    const position = book.initialPage ?? explicitPage ?? (sample ? sampleProgress.position : pending.position?.page ?? 0)
    const anchor = explicitAnchor ?? (explicitPage === undefined && !book.offlineFallback
      ? (sample ? sampleProgress.anchor : queuedPosition?.anchor ?? book.anchor)
      : null)
    const marks = sample ? sampleProgress.highlights : (book.highlights ?? [])
    const highlights = pending
      ? applyPendingHighlights(account, id, [...marks, ...pending.highlights.filter(mark => !marks.some(item => item.id === mark.id))])
      : marks
    const session = {
      preview: Boolean(book.loading), cache, page: position, pages: book.pages, pageCount: book.pageCount,
      highlights: new Map(highlights.map(mark => [mark.id, mark])),
      warm(force = false) { session.cache?.warm(session.page, session.pageCount, session.pages[session.page], { force }) },
    }
    const requestAccount = accountReadingApi(account)
    const notesPath = markId => `/books/${id}/highlights/${markId}/notes`
    const localMark = markId => sample
      ? sampleProgress.highlights.find(mark => mark.id === markId)
      : pendingReading(account, id).highlights.find(mark => mark.id === markId)
    const saveLocalMark = (markId, changes) => {
      if (!sample) {
        const highlight = updatePendingHighlight(account, id, markId, changes)
        session.highlights.set(markId, highlight)
        return highlight
      }
      const index = sampleProgress.highlights.findIndex(mark => mark.id === markId)
      if (index < 0) throw new Error('Destaque não encontrado.')
      const highlight = { ...sampleProgress.highlights[index], ...changes }
      sampleProgress.highlights[index] = highlight
      storeSample(sample, sampleProgress, account)
      return highlight
    }
    async function writeReading(change, { background = false } = {}) {
      if (user?.id !== account) throw new Error('Entre na sua conta para salvar a leitura.')
      if (!offline && !background) await syncPendingReading(requestAccount, account, id).catch(() => {})
      const outcome = await saveReadingChange(requestAccount, account, id, change, {
        online: !offline && navigator.onLine, defer: background,
      })
      if (!outcome.synced) scheduleReadingSync()
      return outcome.value
    }
    function rememberMarks() {
      return saveOfflineBook(account, id, { highlights: [...session.highlights.values()] })
    }
    async function readNotes(markId, signal) {
      const mark = session.highlights.get(markId)
      if (!offline && navigator.onLine) {
        try {
          if (localMark(markId)) await syncPendingReading(requestAccount, account, id).catch(() => {})
          const { notes } = await readRequest(notesPath(markId), signal, account)
          if (mark) await saveOfflineNotes(account, id, markId, notes)
          return mark ? applyPendingNotes(account, id, markId, notes) : notes
        } catch (error) {
          if (signal?.aborted || !isConnectionFailure(error)) throw error
          setOffline(true)
        }
      }
      if (!mark) throw new Error('Conecte-se para ver as notas do grupo.')
      const cachedNotes = await readOfflineNotes(account, id, markId)
      signal?.throwIfAborted()
      return applyPendingNotes(account, id, markId, cachedNotes ?? localHighlightNotes(mark))
    }
    const saveNote = async (markId, noteId, data) => {
      if (sample || session.preview) {
        const result = writeLocalNote(localMark(markId), noteId, data)
        saveLocalMark(markId, result.changes)
        return result.note
      }
      let notes = await readOfflineNotes(account, id, markId) ?? localHighlightNotes(session.highlights.get(markId))
      if (noteId && !offline && !applyPendingNotes(account, id, markId, notes).some(note => note.id === noteId)) {
        notes = await readNotes(markId)
      }
      const current = applyPendingNotes(account, id, markId, notes)
      if (data.scope === 'group' || current.find(note => note.id === noteId)?.scope === 'group') {
        if (offline || !navigator.onLine) throw new Error('Conecte-se para alterar notas do grupo.')
        await syncPendingReading(requestAccount, account, id)
        await syncReadingChanges(requestAccount, account, id)
        const path = notesPath(markId)
        const { note } = await requestAccount(noteId ? `${path}/${noteId}` : path, { method: noteId ? 'PATCH' : 'POST', data })
        await saveOfflineNotes(account, id, markId, [...current.filter(item => item.id !== note.id), note])
        return note
      }
      const { note } = writeLocalNote({ note: '', notes: current }, noteId, data)
      const value = await writeReading({
        kind: noteId ? 'update-note' : 'add-note', markId, noteId,
        data: { ...data, ...(!noteId && { id: note.id }) }, value: note,
      })
      await saveOfflineNotes(account, id, markId, [...current.filter(item => item.id !== note.id), value])
      return value
    }
    const savePosition = async (page, nextAnchor = { block: 0, offset: 0 }) => {
      if (sample) {
        sampleProgress.position = page
        sampleProgress.anchor = nextAnchor
        storeSample(sample, sampleProgress, account)
        return
      }
      if (user?.id !== account) return
      session.page = page
      if (session.preview) {
        savePendingPosition(account, id, page, nextAnchor)
        return
      }
      const data = { page, anchor: nextAnchor, readAt: new Date().toISOString() }
      await writeReading({ kind: 'position', data, value: data }, { background: true })
      const progress = { currentPage: page, anchor: nextAnchor, readAt: data.readAt }
      setBooks(books.map(item => item.id === id ? { ...item, ...progress } : item), { cache: false })
      void saveOfflineBook(account, id, progress)
      session.warm()
      if (!readerBook) renderBookList()
    }

    readerCleanup?.()
    readerSession?.cache?.cleanup()
    socialCleanup?.()
    socialCleanup = undefined
    readerSession = session
    readerBook = { ...book, position, anchor, highlights }
    document.title = `${book.title} — Margem`
    readerCleanup = reader.renderReader(app, {
      book: readerBook,
      offline,
      onRetryConnection: () => { if (navigator.onLine) void reconnect() },
      loadPage: book.loadPage,
      initialHighlightId,
      onExit: exitReader,
      palette: highlightPalette,
      theme: themePreference.theme,
      onChangeTheme: theme => saveReaderTheme(themePreference, theme, session),
      viewerId: account,
      onAddColor: account ? async color => {
        if (offline) throw new Error('Conecte-se para adicionar uma cor à sua paleta.')
        const { colors } = await requestAccount('/reader/colors', { method: 'POST', data: { color } })
        if (user?.id === account) {
          highlightPalette = [...new Set([...colors, ...highlightPalette])]
          void saveOfflineAccount(account, { palette: highlightPalette })
        }
        return colors
      } : undefined,
      onLoadGroup: !sample && account ? (page, groupSignal) => (
        session.preview || offline || user?.id !== account
          ? Promise.resolve({ status: 'unavailable', members: [], highlights: [] })
          : loadReadingGroup(account, id, page, groupSignal)
      ) : undefined,
      onStartGroup: !sample && account ? () => requestAccount(`/social/books/${id}/group`, { method: 'POST', data: {} }) : undefined,
      onRespondGroup: !sample && account ? (groupId, accept) => requestAccount(`/social/groups/${groupId}`, { method: 'PATCH', data: { accept } }) : undefined,
      onPosition: savePosition,
      onAddHighlight: async data => {
        if (sample) {
          const highlight = { ...data, id: crypto.randomUUID() }
          sampleProgress.highlights = [...sampleProgress.highlights, highlight]
          storeSample(sample, sampleProgress, account)
          return highlight
        }
        if (session.preview) {
          const highlight = addPendingHighlight(account, id, data)
          session.highlights.set(highlight.id, highlight)
          return highlight
        }
        const mark = { ...data, id: crypto.randomUUID(), createdAt: new Date().toISOString() }
        const highlight = await writeReading({ kind: 'add-highlight', data: { ...data, id: mark.id }, value: mark })
        session.highlights.set(highlight.id, highlight)
        await rememberMarks()
        setBooks(books.map(item => item.id === id ? { ...item, highlightCount: (item.highlightCount ?? 0) + 1 } : item))
        return highlight
      },
      onUpdateHighlight: async (highlightId, changes) => {
        if (sample || session.preview) return saveLocalMark(highlightId, changes)
        if (offline) throw new Error('Conecte-se para alterar a visibilidade do destaque.')
        await syncPendingReading(requestAccount, account, id)
        await syncReadingChanges(requestAccount, account, id)
        const { highlight } = await requestAccount(`/books/${id}/highlights/${highlightId}`, { method: 'PATCH', data: changes })
        session.highlights.set(highlightId, highlight)
        await rememberMarks()
        return highlight
      },
      loadNotes: async (markId, { signal: noteSignal } = {}) => {
        if (sample || session.preview) return localHighlightNotes(localMark(markId))
        return readNotes(markId, noteSignal)
      },
      addNote: (markId, data) => saveNote(markId, null, data),
      updateNote: (markId, noteId, data) => saveNote(markId, noteId, data),
      deleteNote: async (markId, noteId) => {
        if (sample || session.preview) {
          saveLocalMark(markId, deleteLocalNote(localMark(markId), noteId))
          return
        }
        const notes = await readOfflineNotes(account, id, markId) ?? localHighlightNotes(session.highlights.get(markId))
        await writeReading({ kind: 'remove-note', markId, noteId })
        await saveOfflineNotes(account, id, markId, applyPendingNotes(account, id, markId, notes).filter(note => note.id !== noteId))
      },
      onRemoveHighlight: async highlightId => {
        if (sample) {
          sampleProgress.highlights = sampleProgress.highlights.filter(mark => mark.id !== highlightId)
          storeSample(sample, sampleProgress, account)
          return
        }
        if (session.preview) {
          removePendingHighlight(account, id, highlightId)
          session.highlights.delete(highlightId)
          return
        }
        await writeReading({ kind: 'remove-highlight', markId: highlightId })
        removePendingHighlight(account, id, highlightId)
        session.highlights.delete(highlightId)
        await rememberMarks()
        await saveOfflineNotes(account, id, highlightId, [])
        setBooks(books.map(item => item.id === id ? { ...item, highlightCount: Math.max(0, (item.highlightCount ?? 1) - 1) } : item))
      },
    })
    mounted = true
    recordReaderRoute(id)
    if (openingBook === controller) openingBook = undefined
    if (dialog.open && dialog.dataset.view === 'open-book') dialog.close()
    if (!offline && !session.preview && !sample && (pending.position || pending.highlights.length)) {
      void syncPendingReading(requestAccount, account, id).catch(error => { if (readerSession === session) announce(error.message) })
    }
    if (book.nextHighlightOffset != null) {
      void listAll(`/books/${id}/highlights`, 'highlights', book.nextHighlightOffset, path => readRequest(path, undefined, account))
        .then(additionalHighlights => {
          if (readerSession !== session) return
          const merged = applyPendingHighlights(account, id, [...additionalHighlights, ...session.highlights.values()])
          session.highlights = new Map(merged.map(mark => [mark.id, mark]))
          void rememberMarks()
          readerCleanup.updateBook({ highlights: merged })
        }).catch(error => { if (readerSession === session) announce(error.message) })
    }
    if (book.offlineFallback) announce('Mostrando a página salva mais próxima.')
    if (explicitPage !== undefined) void savePosition(position, explicitAnchor).catch(error => announce(error.message))
    window.scrollTo(0, 0)
  } catch (error) {
    if (active()) {
      showOpenFailure(error, () => void openBook(id, explicitPage, explicitAnchor, initialHighlightId), moduleFailed)
    }
  } finally {
    if (!mounted) cache?.cleanup()
    if (openingBook === controller) {
      openingBook = undefined
      controller.abort()
    }
  }
}

app.addEventListener('click', event => {
  const button = event.target.closest('button')
  if (!button) return
  const { action, section: targetSection, book, deleteBook, page, block, offset, highlightId, filter: targetFilter } = button.dataset
  if (action === 'upload') showUpload()
  if (action === 'read-import-preview') readAvailablePages()
  if (action === 'account') showAccount()
  if (deleteBook) showDeleteBook(deleteBook)
  if (book) {
    const anchor = block === undefined ? undefined : { block: Number(block), offset: Number(offset) }
    void openBook(book, page === undefined ? undefined : Number(page), anchor, highlightId)
  }
  if (targetSection) {
    readerRequest++
    section = targetSection
    renderShell()
    if (section === 'library') void refreshVisibleLibrary()
  }
  if (targetFilter) {
    filter = targetFilter
    app.querySelectorAll('[data-filter]').forEach(item => item.setAttribute('aria-pressed', String(item.dataset.filter === filter)))
    renderBookList()
  }
})

app.addEventListener('input', event => {
  if (event.target.id !== 'search') return
  query = event.target.value
  renderBookList()
})

dialog.addEventListener('cancel', () => {
  if (dialog.dataset.view === 'open-book') openingBook?.abort()
})

window.addEventListener('popstate', () => {
  if (routedBook()) {
    if (dialog.open) dialog.close()
    openCurrentRoute()
  } else {
    showLibraryHome()
  }
})

window.addEventListener('offline', () => setOffline(true))
window.addEventListener('online', () => void reconnect())
window.addEventListener('focus', () => {
  if (navigator.onLine) void reconnect()
})
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && offline && navigator.onLine) void reconnect()
})

dialog.addEventListener('click', async event => {
  const button = event.target.closest('button')
  const action = button?.dataset.action
  if (event.target === dialog || action === 'close-dialog') {
    if (dialog.dataset.view === 'open-book') openingBook?.abort()
    dialog.close()
  }
  if (action === 'read-import') {
    dialog.close()
    void openBook(button.dataset.book)
  }
  if (action === 'read-import-preview') readAvailablePages()
  if (action === 'retry-import' || action === 'discard-import') {
    button.disabled = true
    try {
      if (action === 'retry-import') {
        await imports.retry()
      } else {
        const id = imports.current?.id
        const account = user?.id
        await imports.discard()
        if (id) {
          clearPendingReading(account, id)
          await api(`/imports/${id}`, { method: 'DELETE' }).catch(() => {})
        }
        if (dialog.open && dialog.contains(button)) dialog.close()
      }
    } catch (error) {
      if (dialog.open && dialog.contains(button)) {
        dialog.querySelector('[data-import-message]').textContent = error.message
      } else {
        announce(error.message)
      }
    } finally {
      button.disabled = false
    }
  }
  if (action !== 'logout') return
  if (offline || !navigator.onLine) return announce('Conecte-se para sair da sua conta.')
  button.disabled = true
  try {
    const account = user?.id
    if (account) await syncAccountReading(account)
    await imports.setAccount(null)
    await api('/logout', { method: 'POST', account })
    sessionRevision++
    await useSession(null, null, { verified: true })
    dialog.close()
    renderShell()
  } catch (error) {
    void setupImports()
    announce(error.message)
  } finally {
    button.disabled = false
  }
})

renderShell()
await reconnect({ initial: true })
if (!readerBook && !openingBook) openCurrentRoute()
