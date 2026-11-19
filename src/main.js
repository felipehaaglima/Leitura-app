import './style.css'
import { createImportManager } from './import-jobs.js'
import {
  addPendingHighlight, clearPendingReading, pendingReading, removePendingHighlight,
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

async function api(path, { method = 'GET', data, signal } = {}) {
  const response = await fetch(`/api${path}`, {
    method,
    signal,
    headers: data === undefined ? {} : { 'Content-Type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data),
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

async function readRequest(path, signal) {
  signal?.throwIfAborted()
  const controller = new AbortController()
  const cancel = () => controller.abort(signal.reason)
  signal?.addEventListener('abort', cancel, { once: true })
  const timer = setTimeout(() => controller.abort(), 20_000)
  try {
    return await api(path, { signal: controller.signal })
  } catch (error) {
    signal?.throwIfAborted()
    if (controller.signal.aborted) throw new Error('A resposta demorou demais. Tente novamente.')
    if (error instanceof TypeError) throw new Error('A conexão falhou. Tente novamente.')
    throw error
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', cancel)
  }
}

function savedPageLoader(id) {
  return async (page, signal) => {
    const path = `/books/${id}/page?page=${page}`
    const { chunk, partCount } = await readRequest(path, signal)
    if (typeof chunk !== 'string' || !Number.isSafeInteger(partCount) || partCount < 1) {
      throw new Error('Não foi possível ler o conteúdo desta página.')
    }
    const remaining = await transferParts(partCount - 1, async index => (
      (await readRequest(`${path}&part=${index + 1}`, signal)).chunk
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
      for (const book of await listAll('/highlights', 'books')) {
        if (!imported.has(book.id)) imported.set(book.id, { ...book, highlights: [] })
        imported.get(book.id).highlights.push(...book.highlights)
      }
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
      user = (await api(register ? '/register' : '/login', { method: 'POST', data })).user
      void refreshPalette(user.id)
      setThemeAccount(user.id)
      try { await refreshBooks() } catch (failure) { announce(failure.message) }
      await setupImports()
      dialog.close()
      renderShell()
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
  if (!user) return showAuth('login', showUpload)
  if (imports.current) return showImportProgress()
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

function finishUpload({ id, book, fallbackPages }, accountId) {
  if (user?.id !== accountId) return
  const completedId = id ?? book?.id
  const liveReader = readerBook?.id === completedId && readerSession?.preview ? readerSession : null
  if (liveReader) liveReader.preview = false
  const draft = pendingReading(accountId, completedId)
  const sync = syncPendingReading(api, accountId, completedId).catch(error => announce(error.message))
  if (book) {
    setBooks([book, ...books.filter(item => item.id !== book.id)])
    renderBookList()
  }
  if (liveReader && readerSession === liveReader) {
    const item = book ?? books.find(item => item.id === completedId)
    const patch = {
      loadPage: savedPageLoader(completedId),
      pageCount: item?.pageCount ?? readerBook.pageCount,
      title: item?.title ?? readerBook.title,
      loading: null,
    }
    readerBook = { ...readerBook, ...patch }
    readerCleanup?.updateBook(patch)
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
      await api(`/books/${id}`, { method: 'DELETE' }).catch(failure => {
        if (failure.status !== 404) throw failure
      })
      setBooks(books.filter(item => item.id !== id))
      clearPendingReading(account, id)
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

function setBooks(result) {
  booksVersion++
  books = result
}

async function refreshBooks() {
  const account = user?.id
  const version = ++booksVersion
  const result = account ? await listAll('/books', 'books') : []
  if (account === user?.id && version === booksVersion) books = result
}

async function refreshVisibleLibrary() {
  if (!user || readerBook || section !== 'library' || !document.querySelector('#book-list')) return
  try {
    await refreshBooks()
    renderBookList()
  } catch (error) {
    if (section === 'library' && !readerBook) announce(error.message)
  }
}

async function refreshPalette(account) {
  try {
    const { colors } = await api('/reader/colors')
    if (user?.id === account) {
      highlightPalette = [...new Set([...colors, ...highlightPalette])]
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

function setThemeAccount(account) {
  const preference = { account, theme: account ? 'classic' : guestReaderTheme(), revision: 0, writeQueue: Promise.resolve() }
  themePreference = preference
  readerCleanup?.updateBook({ theme: preference.theme })
  if (account) void refreshReaderTheme(preference)
}

async function refreshReaderTheme(preference) {
  const revision = preference.revision
  try {
    const { theme } = await readRequest('/reader/theme')
    if (themePreference !== preference || revision !== preference.revision) return
    preference.theme = normalizeReaderTheme(theme)
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
      const saved = await api('/reader/theme', { method: 'PUT', data: { theme: savedTheme } })
      savedTheme = normalizeReaderTheme(saved.theme)
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

async function loadReadingGroup(id, page, signal) {
  const path = `/social/books/${id}/group?page=${page}`
  const group = await readRequest(path, signal)
  let offset = group.nextOffset
  while (offset != null) {
    const batch = await readRequest(`${path}&offset=${offset}`, signal)
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

async function loadSavedReading(id, requestedPage, signal) {
  const { book } = await readRequest(`/books/${id}?metadata=1&paged=1`, signal)
  const position = requestedPage ?? book.currentPage ?? 0
  const initialPage = Number.isInteger(position) && position >= 0 && position < book.pageCount ? position : 0
  const pages = new Array(book.pageCount)
  const loadPage = savedPageLoader(id)
  pages[initialPage] = await loadPage(initialPage, signal)
  return { ...book, pages, loadPage, initialPage }
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
  dialog.querySelector('#retry-open-book').onclick = reload ? () => window.location.reload() : retry
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
  const requestedPage = explicitPage ?? pending?.position?.page
  const title = sample?.title ?? saved?.title ?? preview?.title ?? 'Carregando a página de leitura…'
  if (!sample && !preview) showOpeningBook(title)
  let moduleFailed = false
  const active = () => request === readerRequest && user?.id === account && !signal.aborted
  try {
    const [initial, reader] = await Promise.all([
      sample ?? preview ?? loadSavedReading(id, requestedPage, signal),
      import('./reader.js').catch(() => {
        moduleFailed = true
        throw new Error('Atualize a página para carregar o leitor.')
      }),
    ])
    if (!active()) return
    let book = preview ? imports.getPreview(id) : initial
    if (!book) {
      showOpeningBook(title)
      book = await loadSavedReading(id, requestedPage, signal)
    }
    if (!active()) return
    const sampleProgress = sample ? sampleState(sample, account) : null
    const position = book.initialPage ?? explicitPage ?? (sample ? sampleProgress.position : pending.position?.page ?? 0)
    const anchor = explicitAnchor ?? (explicitPage === undefined
      ? (sample ? sampleProgress.anchor : pending.position?.anchor ?? book.anchor)
      : null)
    const marks = sample ? sampleProgress.highlights : (book.highlights ?? [])
    const highlights = pending
      ? [...marks, ...pending.highlights.filter(mark => !marks.some(item => item.id === mark.id))]
      : marks
    const session = { preview: Boolean(book.loading) }
    const notesPath = markId => `/books/${id}/highlights/${markId}/notes`
    const localMark = markId => sample
      ? sampleProgress.highlights.find(mark => mark.id === markId)
      : pendingReading(account, id).highlights.find(mark => mark.id === markId)
    const saveLocalMark = (markId, changes) => {
      if (!sample) return updatePendingHighlight(account, id, markId, changes)
      const index = sampleProgress.highlights.findIndex(mark => mark.id === markId)
      if (index < 0) throw new Error('Destaque não encontrado.')
      const highlight = { ...sampleProgress.highlights[index], ...changes }
      sampleProgress.highlights[index] = highlight
      storeSample(sample, sampleProgress, account)
      return highlight
    }
    const saveNote = async (markId, noteId, data) => {
      if (sample || session.preview) {
        const result = writeLocalNote(localMark(markId), noteId, data)
        saveLocalMark(markId, result.changes)
        return result.note
      }
      await syncPendingReading(api, account, id).catch(() => {})
      const path = notesPath(markId)
      return (await api(noteId ? `${path}/${noteId}` : path, { method: noteId ? 'PATCH' : 'POST', data })).note
    }
    const savePosition = async (page, nextAnchor = { block: 0, offset: 0 }) => {
      if (sample) {
        sampleProgress.position = page
        sampleProgress.anchor = nextAnchor
        storeSample(sample, sampleProgress, account)
        return
      }
      if (user?.id !== account) return
      if (session.preview) {
        savePendingPosition(account, id, page, nextAnchor)
        return
      }
      await syncPendingReading(api, account, id).catch(() => {})
      await api(`/books/${id}/progress`, { method: 'PATCH', data: { page, anchor: nextAnchor } })
      setBooks(books.map(item => item.id === id ? { ...item, currentPage: page, anchor: nextAnchor } : item))
      if (!readerBook) renderBookList()
    }

    readerCleanup?.()
    socialCleanup?.()
    socialCleanup = undefined
    readerSession = session
    readerBook = { ...book, position, anchor, highlights }
    document.title = `${book.title} — Margem`
    readerCleanup = reader.renderReader(app, {
      book: readerBook,
      loadPage: book.loadPage,
      initialHighlightId,
      onExit: exitReader,
      palette: highlightPalette,
      theme: themePreference.theme,
      onChangeTheme: theme => saveReaderTheme(themePreference, theme, session),
      viewerId: account,
      onAddColor: account ? async color => {
        const { colors } = await api('/reader/colors', { method: 'POST', data: { color } })
        if (user?.id === account) highlightPalette = [...new Set([...colors, ...highlightPalette])]
        return colors
      } : undefined,
      onLoadGroup: !sample && account ? (page, groupSignal) => (
        session.preview || user?.id !== account
          ? Promise.resolve({ status: 'unavailable', members: [], highlights: [] })
          : loadReadingGroup(id, page, groupSignal)
      ) : undefined,
      onStartGroup: !sample && account ? () => api(`/social/books/${id}/group`, { method: 'POST', data: {} }) : undefined,
      onRespondGroup: !sample && account ? (groupId, accept) => api(`/social/groups/${groupId}`, { method: 'PATCH', data: { accept } }) : undefined,
      onPosition: savePosition,
      onAddHighlight: async data => {
        if (sample) {
          const highlight = { ...data, id: crypto.randomUUID() }
          sampleProgress.highlights = [...sampleProgress.highlights, highlight]
          storeSample(sample, sampleProgress, account)
          return highlight
        }
        if (session.preview) return addPendingHighlight(account, id, data)
        const { highlight } = await api(`/books/${id}/highlights`, { method: 'POST', data })
        setBooks(books.map(item => item.id === id ? { ...item, highlightCount: (item.highlightCount ?? 0) + 1 } : item))
        return highlight
      },
      onUpdateHighlight: async (highlightId, changes) => {
        if (sample || session.preview) return saveLocalMark(highlightId, changes)
        await syncPendingReading(api, account, id).catch(() => {})
        const { highlight } = await api(`/books/${id}/highlights/${highlightId}`, { method: 'PATCH', data: changes })
        return highlight
      },
      loadNotes: async (markId, { signal: noteSignal } = {}) => {
        if (sample || session.preview) return localHighlightNotes(localMark(markId))
        if (localMark(markId)) await syncPendingReading(api, account, id).catch(() => {})
        return (await readRequest(notesPath(markId), noteSignal)).notes
      },
      addNote: (markId, data) => saveNote(markId, null, data),
      updateNote: (markId, noteId, data) => saveNote(markId, noteId, data),
      deleteNote: async (markId, noteId) => {
        if (sample || session.preview) {
          saveLocalMark(markId, deleteLocalNote(localMark(markId), noteId))
          return
        }
        await syncPendingReading(api, account, id).catch(() => {})
        await api(`${notesPath(markId)}/${noteId}`, { method: 'DELETE' })
      },
      onRemoveHighlight: async highlightId => {
        if (sample) {
          sampleProgress.highlights = sampleProgress.highlights.filter(mark => mark.id !== highlightId)
          storeSample(sample, sampleProgress, account)
          return
        }
        if (session.preview) {
          removePendingHighlight(account, id, highlightId)
          return
        }
        await syncPendingReading(api, account, id).catch(() => {})
        await api(`/books/${id}/highlights/${highlightId}`, { method: 'DELETE' }).catch(error => {
          if (error.status !== 404) throw error
        })
        removePendingHighlight(account, id, highlightId)
        setBooks(books.map(item => item.id === id ? { ...item, highlightCount: Math.max(0, (item.highlightCount ?? 1) - 1) } : item))
      },
    })
    recordReaderRoute(id)
    if (openingBook === controller) openingBook = undefined
    if (dialog.open && dialog.dataset.view === 'open-book') dialog.close()
    if (!session.preview && !sample && (pending.position || pending.highlights.length)) {
      void syncPendingReading(api, account, id).catch(error => { if (readerSession === session) announce(error.message) })
    }
    if (book.nextHighlightOffset != null) {
      void listAll(`/books/${id}/highlights`, 'highlights', book.nextHighlightOffset, readRequest)
        .then(additionalHighlights => {
          if (readerSession === session) readerCleanup.updateBook({ additionalHighlights })
        }).catch(error => { if (readerSession === session) announce(error.message) })
    }
    if (explicitPage !== undefined) void savePosition(position, explicitAnchor).catch(error => announce(error.message))
    window.scrollTo(0, 0)
  } catch (error) {
    if (active()) {
      showOpenFailure(error, () => void openBook(id, explicitPage, explicitAnchor, initialHighlightId), moduleFailed)
    }
  } finally {
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

window.addEventListener('focus', () => void refreshVisibleLibrary())

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
  button.disabled = true
  try {
    await imports.setAccount(null)
    await api('/logout', { method: 'POST' })
    user = null
    setBooks([])
    highlightPalette = []
    setThemeAccount(null)
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
try {
  user = (await api('/session')).user
  if (user) {
    void refreshPalette(user.id)
    setThemeAccount(user.id)
  }
  try { await refreshBooks() } catch (error) { announce(error.message) }
  if (user && !readerBook) renderShell()
  await setupImports()
  openCurrentRoute()
} catch (error) {
  announce(error.message)
}
