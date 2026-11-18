import './style.css'
import { sampleBooks } from './samples.js'

const app = document.querySelector('#app')
const dialog = document.querySelector('#dialog')
const toast = document.querySelector('#toast')

const icons = {
  logo: '<path d="M5 4.75h6.2c1 0 1.8.42 2.8 1.42 1-1 1.8-1.42 2.8-1.42H21v13h-4.2c-1 0-1.8.42-2.8 1.42-1-1-1.8-1.42-2.8-1.42H5z"/><path d="M14 6.4v12.1M5 19.8h6.2c1 0 1.8.42 2.8 1.42 1-1 1.8-1.42 2.8-1.42H21"/>',
  library: '<path d="M4 19V5m4 14V5m4 14V5m4 1 4 13"/>',
  bookmark: '<path d="M6 5a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v15l-6-4-6 4z"/>',
  user: '<circle cx="12" cy="8" r="3"/><path d="M5 20v-2a4 4 0 0 1 4-4h6a4 4 0 0 1 4 4v2"/>',
  upload: '<path d="M12 15V4m-4 4 4-4 4 4M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="m16 16 4 4"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  file: '<path d="M13 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10z"/><path d="M13 3v7h7M8 14h8m-8 3h6"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  external: '<path d="M13 5h6v6m0-6-9 9"/><path d="M19 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/>',
}
const icon = name => `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${icons[name]}</svg>`
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char])
const normalized = value => value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()

let user = null
let books = []
let section = 'library'
let filter = 'all'
let query = ''
let readerCleanup
let readerBook
let readerRequest = 0
let toastTimeout

function announce(message) {
  toast.textContent = message
  toast.hidden = false
  window.clearTimeout(toastTimeout)
  toastTimeout = window.setTimeout(() => { toast.hidden = true }, 4200)
}

async function api(path, { method = 'GET', data } = {}) {
  const response = await fetch(`/api${path}`, {
    method,
    headers: data === undefined ? {} : { 'Content-Type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data),
  })
  const body = await response.json().catch(() => null)
  if (!response.ok || !body) throw new Error(body?.error || 'A biblioteca está indisponível. Tente novamente.')
  return body
}

async function listAll(path, field, offset = 0) {
  const entries = []
  while (offset != null) {
    const page = await api(`${path}?offset=${offset}`)
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

async function uploadBook(document, onProgress) {
  const serialized = JSON.stringify(document)
  const parts = []
  for (let start = 0; start < serialized.length;) {
    let end = Math.min(start + importPartSize, serialized.length)
    const lastCodeUnit = serialized.charCodeAt(end - 1)
    if (lastCodeUnit >= 0xD800 && lastCodeUnit <= 0xDBFF) end--
    parts.push(serialized.slice(start, end))
    start = end
  }
  const { id } = await api('/imports', { method: 'POST', data: { partCount: parts.length } })
  const path = `/imports/${id}`
  try {
    await transferParts(parts.length, part => api(`${path}/${part}`, {
      method: 'PUT', data: { chunk: parts[part] },
    }), onProgress)
    return (await api(`${path}/complete`, { method: 'POST' })).book
  } catch (error) {
    await api(path, { method: 'DELETE' }).catch(() => {})
    throw error
  }
}

async function loadBook(id) {
  const path = `/books/${id}`
  const { book } = await api(`${path}?metadata=1`)
  const [parts, additionalHighlights] = await Promise.all([
    transferParts(book.partCount, async part => (await api(`${path}/data?part=${part}`)).chunk),
    book.nextHighlightOffset == null
      ? []
      : listAll(`${path}/highlights`, 'highlights', book.nextHighlightOffset),
  ])
  return {
    ...book,
    pages: JSON.parse(parts.join('')),
    highlights: [...book.highlights, ...additionalHighlights],
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
  return `<button class="book-card" type="button" data-book="${escape(book.id)}">
    <div class="book-cover ${imported ? 'cover-imported' : `cover-${book.id}`}">${cover}</div>
    <div class="book-caption">
      <h3>${escape(book.title)}</h3>
      <p>${escape(book.author ?? 'PDF importado')}</p>
      <span class="book-genre">${escape(book.genre ?? `${book.pageCount} páginas`)}</span>
    </div>
    ${book.currentPage > 0 ? `<span class="book-progress" aria-label="Página ${book.currentPage + 1} de ${book.pageCount}"><span style="width: ${(book.currentPage + 1) / book.pageCount * 100}%"></span></span>` : ''}
  </button>`
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
        book.highlights.map(mark => `<button type="button" class="highlight-entry" data-book="${escape(book.id)}" data-page="${mark.page}">
          <span class="swatch swatch-${escape(mark.color || 'yellow')}"></span>
          <span><q>${escape(mark.text)}</q><small>Página ${mark.page + 1}</small></span>${icon('chevron')}
        </button>`).join('')
      }</section>`).join('')
      : `<div class="empty">${icon('bookmark')}<h3>Seus destaques aparecem aqui</h3><p>Selecione um trecho durante a leitura para guardá-lo.</p>
        <button class="button primary" type="button" data-section="library">Ver biblioteca</button></div>`
  } catch (error) {
    if (results.isConnected) results.textContent = error.message
  }
}

function renderShell() {
  readerCleanup?.()
  readerCleanup = undefined
  readerBook = undefined
  document.title = 'Margem — Biblioteca de leitura'
  const active = name => section === name ? 'aria-current="page"' : ''
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
      <header class="topbar"><p>${icon(section === 'library' ? 'library' : 'bookmark')} ${section === 'library' ? 'Biblioteca' : 'Destaques'}</p>
        <button class="button topbar-upload" type="button" data-action="upload">${icon('upload')} Importar PDF</button></header>
      ${section === 'library' ? libraryView() : `<div class="page-content highlights-page">
        <div class="page-intro"><h1>Seus destaques</h1><p>Volte aos trechos que você marcou.</p></div>
        <div id="highlight-results" aria-live="polite"><p>Carregando destaques…</p></div>
      </div>`}
    </main>
  </div>`
  if (section === 'library') renderBookList()
  if (section === 'highlights') void renderHighlights()
}

function showDialog(title, contents) {
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
      try { await refreshBooks() } catch (failure) { announce(failure.message) }
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

function showUpload() {
  if (!user) return showAuth('login', showUpload)
  showDialog('Importar PDF', `
    <p class="modal-description">O texto será extraído para o leitor. Páginas digitalizadas serão reconhecidas com OCR em português e inglês.</p>
    <form id="upload-form" class="modal-form">
      <label class="file-drop">${icon('upload')}<strong>Escolha um arquivo PDF</strong><small>Até 80 MB e 500 páginas</small><input type="file" name="file" accept=".pdf,application/pdf" required></label>
      <label>Título opcional<input name="title" maxlength="240" placeholder="Usar o título do PDF"></label>
      <p class="form-error" role="alert" hidden></p>
      <div class="upload-status" hidden><progress></progress><p aria-live="polite"></p></div>
      <button class="button primary full-width" type="submit">${icon('upload')} Importar e preparar leitura</button>
    </form>`)
  dialog.querySelector('#upload-form').onsubmit = async event => {
    event.preventDefault()
    const form = event.currentTarget
    const { file, title } = Object.fromEntries(new FormData(form))
    const submit = form.querySelector('[type=submit]')
    const error = form.querySelector('.form-error')
    const status = form.querySelector('.upload-status')
    const progress = status.querySelector('progress')
    const report = status.querySelector('p')
    submit.disabled = true
    error.hidden = true
    status.hidden = false
    progress.removeAttribute('value')
    report.textContent = 'Abrindo o PDF…'
    dialog.dataset.busy = 'true'
    dialog.querySelector('[data-action=close-dialog]').disabled = true
    try {
      const { importPdf } = await import('./pdf.js')
      const { title: extractedTitle, pages, thumbnail, fallbackPages } = await importPdf(file, {
        onProgress: ({ stage, current, total, fraction = 0 }) => {
          if (!total) return
          progress.max = total
          progress.value = stage === 'complete' ? total : Math.max(0, current - 1 + fraction)
          report.textContent = stage === 'ocr'
            ? `Reconhecendo texto da página ${current} de ${total}…`
            : `Processando página ${current} de ${total}…`
        },
      })
      report.textContent = 'Salvando na sua biblioteca…'
      progress.removeAttribute('value')
      const book = await uploadBook({ title: title.trim() || extractedTitle, pages, thumbnail },
        (current, total) => {
          report.textContent = current === total ? 'Concluindo a importação…' : 'Salvando na sua biblioteca…'
          progress.max = total
          progress.value = current
        })
      books = [book, ...books]
      section = 'library'
      filter = 'all'
      query = ''
      dialog.close()
      const count = fallbackPages.length
      announce(count
        ? `PDF adicionado. ${count === 1 ? 'Uma página foi preservada como imagem.' : `${count} páginas foram preservadas como imagens.`}`
        : 'PDF adicionado à biblioteca.')
      await openBook(book.id)
    } catch (failure) {
      error.hidden = false
      error.textContent = failure.message
    } finally {
      delete dialog.dataset.busy
      const close = dialog.querySelector('[data-action=close-dialog]')
      if (close) close.disabled = false
      status.hidden = true
      submit.disabled = false
    }
  }
}

async function refreshBooks() {
  books = user ? await listAll('/books', 'books') : []
}

async function openBook(id, explicitPage) {
  const request = ++readerRequest
  try {
    const sample = sampleBooks.find(book => book.id === id)
    const [book, reader] = await Promise.all([
      sample ? Promise.resolve(sample) : loadBook(id),
      import('./reader.js'),
    ])
    if (request !== readerRequest) return
    const account = user?.id
    const sampleProgress = sample ? sampleState(sample, account) : null
    const position = explicitPage ?? (sample ? sampleProgress.position : book.currentPage)
    const highlights = sample ? sampleProgress.highlights : book.highlights
    const savePosition = async page => {
      if (sample) {
        sampleProgress.position = page
        storeSample(sample, sampleProgress, account)
        return
      }
      await api(`/books/${id}/progress`, { method: 'PATCH', data: { page } })
      books = books.map(item => item.id === id ? { ...item, currentPage: page } : item)
      if (!readerBook) renderBookList()
    }

    readerCleanup?.()
    readerBook = { ...book, position, highlights }
    document.title = `${book.title} — Margem`
    readerCleanup = reader.renderReader(app, {
      book: readerBook,
      onExit: () => {
        renderShell()
        window.scrollTo(0, 0)
      },
      onPosition: savePosition,
      onAddHighlight: async data => {
        if (sample) {
          const highlight = { ...data, id: crypto.randomUUID() }
          sampleProgress.highlights = [...sampleProgress.highlights, highlight]
          storeSample(sample, sampleProgress, account)
          return highlight
        }
        const { highlight } = await api(`/books/${id}/highlights`, { method: 'POST', data })
        books = books.map(item => item.id === id ? { ...item, highlightCount: (item.highlightCount ?? 0) + 1 } : item)
        return highlight
      },
      onRemoveHighlight: async highlightId => {
        if (sample) {
          sampleProgress.highlights = sampleProgress.highlights.filter(mark => mark.id !== highlightId)
          storeSample(sample, sampleProgress, account)
          return
        }
        await api(`/books/${id}/highlights/${highlightId}`, { method: 'DELETE' })
        books = books.map(item => item.id === id ? { ...item, highlightCount: Math.max(0, (item.highlightCount ?? 1) - 1) } : item)
      },
    })
    if (explicitPage !== undefined) void savePosition(explicitPage).catch(error => announce(error.message))
    window.scrollTo(0, 0)
  } catch (error) {
    announce(error.message)
  }
}

app.addEventListener('click', event => {
  const button = event.target.closest('button')
  if (!button) return
  const { action, section: targetSection, book, page, filter: targetFilter } = button.dataset
  if (action === 'upload') showUpload()
  if (action === 'account') showAccount()
  if (book) void openBook(book, page === undefined ? undefined : Number(page))
  if (targetSection) {
    readerRequest++
    section = targetSection
    renderShell()
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

dialog.addEventListener('cancel', event => {
  if (dialog.dataset.busy) event.preventDefault()
})

dialog.addEventListener('click', async event => {
  const action = event.target.closest('button')?.dataset.action
  if (!dialog.dataset.busy && (event.target === dialog || action === 'close-dialog')) dialog.close()
  if (action !== 'logout') return
  try {
    await api('/logout', { method: 'POST' })
    user = null
    books = []
    dialog.close()
    renderShell()
  } catch (error) {
    announce(error.message)
  }
})

renderShell()
try {
  user = (await api('/session')).user
  await refreshBooks()
  if (user && !readerBook) renderShell()
} catch (error) {
  announce(error.message)
}
