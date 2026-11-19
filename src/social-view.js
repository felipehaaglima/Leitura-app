import './social-view.css'

const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character])

const route = (collection, id) => `/social/${collection}/${encodeURIComponent(id)}`

function avatar(name) {
  const initials = String(name ?? '').trim().split(/\s+/).slice(0, 2)
    .map(part => Array.from(part)[0] ?? '').join('').toLocaleUpperCase('pt-BR')
  return `<span class="social-avatar" aria-hidden="true">${escape(initials || 'M')}</span>`
}

function action(name, label, { id = '', primary = false, disabled = false, accept } = {}) {
  return `<button class="button ${primary ? 'primary' : 'secondary'}" type="button"
    data-social-action="${name}" data-id="${escape(id)}"
    ${accept === undefined ? '' : `data-accept="${accept}"`} ${disabled ? 'disabled' : ''}>${label}</button>`
}

function ownIdentity(id) {
  return `<div class="social-connect">
    <section class="social-connect-item" aria-labelledby="social-own-title">
      <h2 id="social-own-title">Seu ID</h2>
      <p>Compartilhe este ID com quem você quer adicionar.</p>
      <div class="social-inline-form">
        <input aria-label="Seu ID de usuário" value="${escape(id)}" readonly data-social-own-id>
        ${action('copy-id', 'Copiar ID')}
      </div>
    </section>
    <form class="social-connect-item" aria-labelledby="social-add-title" data-social-add-friend>
      <h2 id="social-add-title">Adicionar amigo</h2>
      <p><label for="social-friend-id">Cole o ID de quem você quer adicionar.</label></p>
      <div class="social-inline-form">
        <input id="social-friend-id" name="id" placeholder="ID do amigo" autocomplete="off" autocapitalize="off"
          spellcheck="false" maxlength="100" required>
        <button class="button primary" type="submit">Enviar pedido</button>
      </div>
    </form>
  </div>`
}

function friendRow(friend) {
  return `<li>
    <button type="button" class="social-friend" data-social-action="profile" data-id="${escape(friend.id)}">
      ${avatar(friend.name)}
      <span class="social-friend-name">${escape(friend.name)}</span>
      <span class="social-friend-link">Ver perfil</span>
    </button>
  </li>`
}

function mentionRow(mention) {
  const author = mention.author?.name || 'Leitor'
  return `<li>
    <button type="button" class="social-mention" data-social-action="open-mention" data-id="${escape(mention.id)}">
      ${avatar(author)}
      <span class="social-mention-body">
        <strong>${escape(mention.title)}</strong>
        <span class="social-mention-source">${escape(author)} mencionou você · Página ${escape(mention.page + 1)}</span>
        <q>${escape(mention.text)}</q>
      </span>
    </button>
  </li>`
}

function requestRow(kind, request, busy) {
  const group = kind === 'groups'
  const share = kind === 'shares'
  const incoming = group || request.incoming
  const name = group ? request.invitedBy.name : request.user.name
  const title = group ? request.title : share ? request.book.title : name
  const detail = group ? `Convite de ${name}` :
    share ? (incoming ? `${name} solicitou uma cópia` : `Aguardando aprovação de ${name}`) :
      incoming ? 'Pedido recebido' : 'Pedido enviado'
  const approve = group ? 'Entrar no grupo' : 'Aceitar'
  return `<li class="social-request" data-social-row>
    <div class="social-row-description">
      <strong>${escape(title)}</strong>
      <p>${escape(detail)}</p>
    </div>
    <div class="social-row-actions">
      ${incoming ? action(kind, approve, { id: request.id, accept: true, primary: true, disabled: busy }) : ''}
      ${action(kind, incoming ? 'Recusar' : 'Cancelar', { id: request.id, accept: false, disabled: busy })}
    </div>
  </li>`
}

function requestsGroup(title, kind, requests, busy) {
  if (!requests.length) return ''
  return `<section class="social-request-group">
    <h3>${title}</h3>
    <ul>${requests.map(request => requestRow(kind, request, busy.has(`${kind}:${request.id}`))).join('')}</ul>
  </section>`
}

function bookRow(book, busy) {
  const total = Number.isInteger(book.pageCount) && book.pageCount > 0 ? book.pageCount : 0
  const page = Math.min(total, Math.max(1, (Number.isInteger(book.currentPage) ? book.currentPage : 0) + 1))
  const shareStatus = book.shareStatus ?? 'available'
  const label = ({ requested: 'Cópia solicitada', copied: 'Cópia na biblioteca' })[shareStatus] ?? 'Solicitar cópia'
  return `<li class="social-book" data-social-row>
    <div class="social-row-description">
      <h3>${escape(book.title)}</h3>
      ${book.recommendedBy ? `<p>Indicado por ${escape(book.recommendedBy.name)}</p>` : ''}
      ${total ? `<div class="social-reading-progress">
        <progress max="${total}" value="${page}" aria-label="Progresso em ${escape(book.title)}"></progress>
        <span>Página ${page} de ${total}</span>
      </div>` : ''}
    </div>
    ${action('request-copy', label, { id: book.id, disabled: busy || shareStatus !== 'available' })}
  </li>`
}

export function renderSocial(root, { user, api, onSignIn, onBook, onLibraryChanged }) {
  const controller = new AbortController()
  const { signal } = controller
  const page = document.createElement('div')
  page.className = 'page-content social-page'
  page.innerHTML = `<header class="page-intro social-heading">
    <div><h1>Social</h1><p>Acompanhe as leituras dos seus amigos.</p></div>
    ${user ? action('refresh', 'Atualizar') : ''}
  </header>
  ${user ? `<p class="social-feedback" role="status" data-social-notice hidden></p>
  <p class="social-feedback social-feedback-error" role="alert" data-social-error hidden></p>
  <div data-social-overview>
    ${ownIdentity(user.id)}
    <section class="social-panel social-mentions" data-social-mentions aria-labelledby="social-mentions-title" hidden></section>
    <div class="social-board" data-social-board aria-busy="true">
      <p class="social-empty">Carregando amigos e pedidos…</p>
    </div>
  </div>
  <section data-social-profile aria-label="Perfil de leitura" hidden>
    ${action('back', 'Voltar ao Social')}
    <div class="social-profile-heading" data-social-profile-heading></div>
    <div class="social-panel" data-social-books></div>
  </section>` : `<div class="social-panel social-guest">
    <h2>Seus amigos e livros</h2>
    <p>Entre para adicionar amigos, acompanhar leituras e participar de grupos.</p>
    ${action('sign-in', 'Entrar', { primary: true })}
  </div>`}`
  root.replaceChildren(page)
  const find = selector => page.querySelector(selector)
  const cleanup = () => controller.abort()
  if (!user) {
    find('[data-social-action=sign-in]').addEventListener('click', () => onSignIn(), { signal })
    return cleanup
  }

  const apiRequest = (path, options = {}) => api(path, { ...options, signal })
  const busy = new Set()
  const board = find('[data-social-board]')
  const profilePane = find('[data-social-profile]')
  const profileHeading = find('[data-social-profile-heading]')
  const profileBooks = find('[data-social-books]')
  const refresh = find('[data-social-action=refresh]')
  const overviewPane = find('[data-social-overview]')
  const mentionsPane = find('[data-social-mentions]')
  let overview
  let friend
  let profile
  let mentionPage
  let mentionsLoading = false
  let mentionsFailed = false
  let overviewLoading = false
  let overviewQueued = false
  let profileLoading = false
  let profileSequence = 0

  function writeFeedback(selector, message = '') {
    const element = find(selector)
    element.textContent = message
    element.hidden = !message
  }

  const announce = message => writeFeedback('[data-social-notice]', message)
  const showError = failure => writeFeedback('[data-social-error]', failure
    ? failure.message || 'Ocorreu um erro. Tente novamente.'
    : '')

  function updateRefresh() {
    refresh.disabled = friend ? profileLoading : overviewLoading
  }

  function renderOverview() {
    if (!overview) return
    const { friends, friendRequests, shareRequests, groupInvites } = overview
    const groups = [
      requestsGroup('Amizades', 'friends', friendRequests, busy),
      requestsGroup('Cópias de livros', 'shares', shareRequests, busy),
      requestsGroup('Leitura em grupo', 'groups', groupInvites, busy),
    ].join('')
    board.innerHTML = `<section class="social-panel">
      <h2>Amigos</h2>
      ${friends.length ? `<ul class="social-friends">${friends.map(friendRow).join('')}</ul>` :
        '<p class="social-empty">Você ainda não adicionou amigos.</p>'}
    </section>
    <section class="social-panel">
      <h2>Pedidos e convites</h2>
      ${groups || '<p class="social-empty">Você não tem pedidos nem convites pendentes.</p>'}
    </section>`
  }

  function renderMentions() {
    const mentions = mentionPage?.mentions ?? []
    mentionsPane.hidden = !mentions.length
    mentionsPane.setAttribute('aria-busy', String(mentionsLoading))
    mentionsPane.innerHTML = mentions.length ? `
      <h2 id="social-mentions-title">Menções</h2>
      <ul class="social-mentions-list">${mentions.map(mentionRow).join('')}</ul>
      ${mentionsFailed ? '<p class="social-empty" role="status">Não foi possível atualizar as menções.</p>' : ''}
      ${mentionPage.nextOffset != null ? action('more-mentions', 'Carregar mais', { disabled: mentionsLoading }) : ''}`
      : ''
  }

  async function loadMentions(append = false) {
    if (signal.aborted || mentionsLoading || (append && mentionPage?.nextOffset == null)) return
    const offset = append ? mentionPage.nextOffset : 0
    const more = mentionsPane.querySelector('[data-social-action=more-mentions]')
    const restoreFocus = append && document.activeElement === more
    mentionsLoading = true
    mentionsPane.setAttribute('aria-busy', 'true')
    if (more) more.disabled = true
    try {
      const result = await apiRequest(`/reader/mentions?offset=${encodeURIComponent(offset)}`)
      if (signal.aborted) return
      const previous = append ? mentionPage.mentions : []
      const known = new Set(previous.map(mention => mention.id))
      mentionPage = {
        mentions: [...previous, ...result.mentions.filter(mention => !known.has(mention.id))],
        nextOffset: result.nextOffset,
      }
      mentionsFailed = false
    } catch {
      mentionsFailed = true
    } finally {
      mentionsLoading = false
      if (!signal.aborted) {
        const keepFocus = restoreFocus && (document.activeElement === more || document.activeElement === document.body)
        renderMentions()
        if (keepFocus) {
          const nextControl = mentionsPane.querySelector('[data-social-action=more-mentions]') ??
            mentionsPane.querySelector('li:last-child button')
          nextControl?.focus({ preventScroll: true })
        }
      }
    }
  }

  async function openMention(id, button) {
    const mention = mentionPage?.mentions.find(item => item.id === id)
    if (!mention) return
    button.disabled = true
    showError()
    try {
      await onBook(mention.bookId, mention.page, { block: mention.block, offset: mention.start }, mention.highlightId)
    } catch (error) {
      if (!signal.aborted) showError(error)
    } finally {
      if (!signal.aborted) button.disabled = false
    }
  }

  async function loadOverview({ clearError = false } = {}) {
    if (signal.aborted) return
    if (overviewLoading) {
      overviewQueued = true
      return
    }
    if (clearError) showError()
    overviewLoading = true
    board.setAttribute('aria-busy', 'true')
    updateRefresh()
    try {
      const data = await apiRequest('/social')
      if (signal.aborted || overviewQueued) return
      const resolvedCopyRequest = overview?.shareRequests.some(request =>
        !request.incoming && !data.shareRequests.some(item => item.id === request.id))
      overview = data
      renderOverview()
      if (clearError || resolvedCopyRequest) refreshLibrary()
    } catch (error) {
      if (signal.aborted) return
      if (!overview) board.innerHTML = '<p class="social-empty">Não foi possível carregar o Social.</p>'
      showError(error)
    } finally {
      overviewLoading = false
      if (!signal.aborted) {
        board.setAttribute('aria-busy', 'false')
        updateRefresh()
        if (overviewQueued) {
          overviewQueued = false
          void loadOverview()
        }
      }
    }
  }

  function renderProfile() {
    if (!friend) return
    const name = profile?.user.name ?? friend.name
    const heading = profileHeading.querySelector('h2')
    if (heading?.textContent !== name) {
      profileHeading.innerHTML = `${avatar(name)}<h2 tabindex="-1">${escape(name)}</h2>`
    }
    const books = profile?.books ?? []
    profileBooks.innerHTML = `<h3>Livros</h3>
      ${books.length ? `<ul class="social-books">${books.map(book => bookRow(book, busy.has(`copy:${book.id}`))).join('')}</ul>` :
        `<p class="social-empty">${profileLoading ? 'Carregando livros…' :
          profile ? 'Nenhum livro nesta biblioteca.' : 'Não foi possível carregar os livros.'}</p>`}
      ${profile?.nextOffset != null ? action('more', 'Carregar mais livros', { disabled: profileLoading }) : ''}`
    profileBooks.setAttribute('aria-busy', String(profileLoading))
  }

  async function loadProfile(append = false) {
    if (!friend || profileLoading || (append && profile?.nextOffset == null)) return
    const id = friend.id
    const sequence = ++profileSequence
    const offset = append ? profile.nextOffset : 0
    showError()
    profileLoading = true
    updateRefresh()
    renderProfile()
    try {
      const result = await apiRequest(`${route('users', id)}?offset=${encodeURIComponent(offset)}`)
      if (signal.aborted || sequence !== profileSequence) return
      profile = append ? {
        ...result,
        books: [...profile.books, ...result.books.filter(book => !profile.books.some(item => item.id === book.id))],
      } : result
    } catch (error) {
      if (!signal.aborted && sequence === profileSequence) showError(error)
    } finally {
      if (!signal.aborted && sequence === profileSequence) {
        profileLoading = false
        updateRefresh()
        renderProfile()
      }
    }
  }

  function openProfile(nextFriend) {
    if (!nextFriend) return
    friend = nextFriend
    profile = null
    overviewPane.hidden = true
    profilePane.hidden = false
    announce()
    void loadProfile()
    profileHeading.querySelector('h2')?.focus({ preventScroll: true })
  }

  function back() {
    profileSequence++
    friend = null
    profile = null
    profileLoading = false
    profilePane.hidden = true
    overviewPane.hidden = false
    updateRefresh()
    showError()
    announce()
    refresh.focus({ preventScroll: true })
  }

  async function mutate(key, control, path, { method, data, success }) {
    if (busy.has(key) || signal.aborted) return
    busy.add(key)
    const row = control.closest('[data-social-row]')
    const controls = row ? [...row.querySelectorAll('button:not([disabled])')] : [control]
    controls.forEach(button => { button.disabled = true })
    showError()
    announce()
    try {
      const result = await apiRequest(path, { method, data })
      if (!signal.aborted) await success(result)
    } catch (error) {
      if (!signal.aborted) showError(error)
    } finally {
      busy.delete(key)
      if (!signal.aborted) {
        controls.forEach(button => { button.disabled = false })
        if (row && !row.isConnected) {
          if (friend) renderProfile()
          else renderOverview()
        }
      }
    }
  }

  function refreshLibrary() {
    void Promise.resolve().then(() => {
      if (!signal.aborted) return onLibraryChanged()
    }).catch(error => {
      if (!signal.aborted) showError(error)
    })
  }

  function respond(kind, button) {
    const { id, accept: choice } = button.dataset
    const collection = ({ friends: 'friendRequests', shares: 'shareRequests', groups: 'groupInvites' })[kind]
    const request = overview?.[collection].find(item => item.id === id)
    if (!request) return
    const accept = choice === 'true'
    void mutate(`${kind}:${id}`, button, route(kind, id), {
      method: 'PATCH',
      data: { accept },
      async success(result) {
        overview = { ...overview, [collection]: overview[collection].filter(item => item.id !== id) }
        renderOverview()
        if (accept && kind === 'groups') {
          await onBook(result?.book?.id ?? result?.bookId ?? request.bookId)
          return
        }
        const message = accept ? (kind === 'friends' ? 'Amigo adicionado.' : `Cópia enviada para ${request.user.name}.`) :
          request.incoming || kind === 'groups' ? 'Pedido recusado.' : 'Pedido cancelado.'
        announce(message)
        if (accept && kind === 'shares') refreshLibrary()
        void loadOverview()
      },
    })
  }

  async function copyIdentity() {
    showError()
    try {
      await navigator.clipboard.writeText(user.id)
      if (!signal.aborted) announce('ID copiado.')
    } catch {
      if (signal.aborted) return
      const input = find('[data-social-own-id]')
      input.focus()
      input.select()
      announce('ID selecionado. Copie para compartilhar.')
    }
  }

  const addFriend = find('[data-social-add-friend]')
  addFriend.addEventListener('submit', event => {
    event.preventDefault()
    const input = addFriend.elements.id
    const id = input.value.trim()
    if (!id) {
      showError(new Error('Informe o ID do seu amigo.'))
      input.focus()
      return
    }
    void mutate('add-friend', addFriend.querySelector('button'), '/social/friends', {
      method: 'POST',
      data: { id },
      success() {
        input.value = ''
        announce('Pedido de amizade enviado.')
        void loadOverview()
      },
    })
  }, { signal })

  page.addEventListener('click', event => {
    const button = event.target.closest('button[data-social-action]')
    if (!button || button.disabled) return
    const { socialAction, id } = button.dataset
    if (socialAction === 'refresh') {
      if (friend) void loadProfile()
      else {
        void loadOverview({ clearError: true })
        void loadMentions()
      }
    } else if (socialAction === 'copy-id') {
      void copyIdentity()
    } else if (socialAction === 'profile') {
      openProfile(overview?.friends.find(item => item.id === id))
    } else if (socialAction === 'back') {
      back()
    } else if (socialAction === 'more') {
      void loadProfile(true)
    } else if (socialAction === 'more-mentions') {
      void loadMentions(true)
    } else if (socialAction === 'open-mention') {
      void openMention(id, button)
    } else if (socialAction === 'request-copy') {
      const target = friend?.id
      void mutate(`copy:${id}`, button, '/social/shares', {
        method: 'POST',
        data: { bookId: id },
        success() {
          if (profile && target === friend?.id) {
            profile = { ...profile, books: profile.books.map(book =>
              book.id === id ? { ...book, shareStatus: 'requested' } : book) }
            renderProfile()
          }
          announce('Solicitação de cópia enviada.')
          void loadOverview()
        },
      })
    } else if (['friends', 'shares', 'groups'].includes(socialAction)) {
      respond(socialAction, button)
    }
  }, { signal })

  void loadOverview()
  void loadMentions()
  return cleanup
}
