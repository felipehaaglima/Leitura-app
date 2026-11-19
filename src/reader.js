import "@fontsource/tinos/latin-400.css";
import "./reader.css";
import { paginatePage } from "./pagination.js";
import { installReaderTouch } from "./reader-touch.js";

const icons = {
  library: '<path d="M3 4h3v16H3zM9 4h3v16H9zM15 5l3-1 4 15-3 1z" />',
  left: '<path d="m14 6-6 6 6 6" />',
  right: '<path d="m10 6 6 6-6 6" />',
  bookmark: '<path d="M6 4h12v16l-6-3.8L6 20V4Z" />',
  mark: '<path d="m8 16-3 2m11-14 4 4-8 8H8v-4l8-8ZM5 21h14" />',
  dictionary: '<path d="M12 6a8 8 0 0 0-9-2v14a8 8 0 0 1 9 2 8 8 0 0 1 9-2V4a8 8 0 0 0-9 2Zm0 0v14" />',
  translate: '<path d="M3 5h11M8.5 3v2m2.8 0c-.5 4.5-3.4 7.4-7.8 9.5m2.1-6.2c1.1 2 2.8 3.9 5 5.2M12 21l4.5-10L21 21m-7.6-3h6.2" />',
  close: '<path d="m6 6 12 12M18 6 6 18" />',
  trash: '<path d="M4 7h16m-14 0 1 13h10l1-13M9 7V4h6v3m-5 3v6m4-6v6" />',
};

const tones = {
  yellow: "Amarelo",
  green: "Verde",
  pink: "Rosa",
};

const defaultPreferences = { size: 21, target: "pt" };
const readingSettingsKey = "leitura.reader.settings";

function icon(name) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;
}

function readPreferences() {
  try {
    const saved = JSON.parse(localStorage.getItem(readingSettingsKey));
    if (!saved) return { ...defaultPreferences };
    return {
      size: Number.isInteger(saved.size) && saved.size >= 15 && saved.size <= 33 ? saved.size : defaultPreferences.size,
      target: ["pt", "en", "es", "fr", "de", "it"].includes(saved.target) ? saved.target : defaultPreferences.target,
    };
  } catch {
    return { ...defaultPreferences };
  }
}

function showAnnotations(container, text, annotations) {
  const cuts = new Set([0, text.length]);
  const valid = annotations.filter(({ start, end }) =>
    Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start && end <= text.length,
  );

  for (const { start, end } of valid) {
    cuts.add(start);
    cuts.add(end);
  }

  const offsets = Array.from(cuts).sort((left, right) => left - right);
  for (let index = 1; index < offsets.length; index++) {
    const start = offsets[index - 1];
    const end = offsets[index];
    const annotation = valid.findLast((item) => item.start <= start && item.end >= end);
    if (annotation) {
      const mark = document.createElement("mark");
      mark.dataset.color = annotation.color;
      mark.textContent = text.slice(start, end);
      container.append(mark);
    } else {
      container.append(text.slice(start, end));
    }
  }
}

function textOffset(block, node, offset) {
  const prefix = document.createRange();
  prefix.selectNodeContents(block);
  prefix.setEnd(node, offset);
  return prefix.toString().length;
}

function selectionFragments(article, range) {
  const fragments = [];
  for (const block of article.querySelectorAll("[data-reader-block]")) {
    if (!range.intersectsNode(block)) continue;

    const text = block.textContent;
    const start = block.contains(range.startContainer)
      ? textOffset(block, range.startContainer, range.startOffset)
      : 0;
    const end = block.contains(range.endContainer)
      ? textOffset(block, range.endContainer, range.endOffset)
      : text.length;
    if (end > start && text.slice(start, end).trim()) {
      const sourceStart = Number(block.dataset.readerStart);
      fragments.push({
        block: Number(block.dataset.readerBlock),
        start: sourceStart + start,
        end: sourceStart + end,
        text: text.slice(start, end),
      });
    }
  }
  return fragments;
}

function firstAnchor(part) {
  return { block: part?.[0]?.block ?? 0, offset: part?.[0]?.start ?? 0 };
}

function partAt(parts, anchor) {
  if (!anchor) return 0;
  return Math.max(0, parts.findLastIndex((part) => {
    const start = firstAnchor(part);
    return start.block < anchor.block || (start.block === anchor.block && start.offset <= anchor.offset);
  }));
}

function partSuffix(index) {
  let suffix = "";
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) {
    suffix = String.fromCharCode(97 + ((value - 1) % 26)) + suffix;
  }
  return suffix;
}

export function renderReader(root, { book, onExit, onPosition, onAddHighlight, onRemoveHighlight, loadPage }) {
  let pages = book.pages ?? [];
  let knownCount = book.pageCount;
  let loading = book.loading ?? null;
  const initialPage = Number.isInteger(book.position) && book.position >= 0 ? book.position : 0;
  let page = pages[initialPage] || (loadPage && initialPage < knownCount)
    ? initialPage : Math.max(0, pages.findIndex(Boolean));
  let anchor = page === initialPage ? book.anchor : undefined;
  let parts = [[]];
  let part = 0;
  let displayed;
  let request = 0;
  let pageLoad;
  let retryPage;
  let layoutSize;
  let layoutController = new AbortController();
  const layouts = new Map();
  let highlights = [...(book.highlights ?? [])];
  const removedHighlights = new Set();
  let highlightRepaintPending = false;
  let positionUpdates = Promise.resolve();
  let preferences = readPreferences();
  let controlsOpen = false;
  let selectionData;
  let touchRange;
  let touchControls;
  let activePanel;
  let tap;
  let tapTimer;
  let selectionTimer;
  let menuTap;
  let lastMenuTouch;
  let notificationTimer;

  const controller = new AbortController();
  const { signal } = controller;
  const element = document.createElement("div");
  element.className = "lr-reader";
  element.innerHTML = `
    <header class="lr-header" id="lr-reader-tools" hidden>
      <button type="button" class="lr-back" aria-label="Voltar à biblioteca">${icon("library")}<span>Biblioteca</span></button>
      <h1 class="lr-title"></h1>
      <div class="lr-header-actions">
        <button type="button" class="lr-header-control" data-toggle="appearance" aria-controls="lr-appearance" aria-expanded="false" aria-label="Aparência" title="Aparência"><span class="lr-aa" aria-hidden="true">Aa</span></button>
        <button type="button" class="lr-header-control" data-toggle="highlights" aria-controls="lr-highlights" aria-expanded="false" aria-label="Destaques" title="Destaques">${icon("bookmark")}</button>
      </div>
    </header>
    <main class="lr-scroll" aria-label="Área de leitura">
      <article class="lr-paper" aria-label="Página de leitura"></article>
    </main>
    <footer class="lr-footer">
      <span class="lr-loading" role="progressbar" aria-valuemin="0" aria-valuemax="100" hidden></span>
      <button type="button" class="lr-counter" aria-controls="lr-reader-tools lr-reader-navigation" aria-expanded="false"></button>
      <div class="lr-navigation" id="lr-reader-navigation" hidden>
        <progress aria-label="Progresso da leitura"></progress>
        <a class="lr-source" target="_blank" rel="noopener noreferrer" hidden>Ler obra completa na Wikisource</a>
        <div class="lr-pagination">
          <button type="button" class="lr-page-step" aria-label="Voltar página" title="Voltar página" data-step="-1">${icon("left")}</button>
          <form class="lr-page-form">
            <label for="lr-page-number">Página</label>
            <input id="lr-page-number" type="text" inputmode="numeric" pattern="[0-9]+" autocomplete="off" required>
            <span class="lr-page-total"></span>
            <button type="submit" class="lr-screen-reader-only">Ir à página</button>
          </form>
          <button type="button" class="lr-page-step" aria-label="Avançar página" title="Avançar página" data-step="1">${icon("right")}</button>
        </div>
        <span class="lr-percent" aria-hidden="true"></span>
      </div>
      <div class="lr-page-alert" hidden>
        <span role="status"></span>
        <button type="button" hidden>Tentar novamente</button>
      </div>
      <span class="lr-status" role="status"></span>
    </footer>
    <section id="lr-appearance" class="lr-panel" data-panel="appearance" aria-labelledby="lr-appearance-title" hidden>
      <div class="lr-panel-heading"><h2 id="lr-appearance-title">Aparência</h2><button type="button" class="lr-panel-close" aria-label="Fechar aparência">${icon("close")}</button></div>
      <div class="lr-panel-row">
        <span>Tamanho do texto</span>
        <div class="lr-size-controls">
          <button type="button" aria-label="Diminuir texto" data-size="-1">A−</button>
          <output class="lr-size-value" aria-live="polite"></output>
          <button type="button" aria-label="Aumentar texto" data-size="1">A+</button>
        </div>
      </div>
      <label class="lr-panel-row" for="lr-language">Traduzir para
        <select id="lr-language">
          <option value="pt">Português</option><option value="en">Inglês</option>
          <option value="es">Espanhol</option><option value="fr">Francês</option>
          <option value="de">Alemão</option><option value="it">Italiano</option>
        </select>
      </label>
    </section>
    <section id="lr-highlights" class="lr-panel" data-panel="highlights" aria-labelledby="lr-highlights-title" hidden>
      <div class="lr-panel-heading"><h2 id="lr-highlights-title">Destaques</h2><button type="button" class="lr-panel-close" aria-label="Fechar destaques">${icon("close")}</button></div>
      <div class="lr-highlights-list"></div>
    </section>
    <div class="lr-selection" aria-label="Ações para a seleção" role="group" hidden>
      <div class="lr-selection-actions">
        <button type="button" class="lr-selection-action" data-highlight-toggle aria-controls="lr-colors" aria-expanded="false">${icon("mark")}<span>Destacar</span></button>
        <a class="lr-selection-action" data-dictionary target="_blank" rel="noopener noreferrer">${icon("dictionary")}<span>Dicionário</span></a>
        <a class="lr-selection-action" data-translate target="_blank" rel="noopener noreferrer">${icon("translate")}<span>Traduzir</span></a>
      </div>
      <div id="lr-colors" class="lr-colors" hidden>
        ${Object.entries(tones).map(([color, label]) => `<button type="button" data-color="${color}" aria-label="Destacar em ${label.toLowerCase()}" title="${label}"></button>`).join("")}
      </div>
    </div>`;

  const find = (selector) => element.querySelector(selector);
  const scroll = find(".lr-scroll");
  const article = find(".lr-paper");
  const header = find(".lr-header");
  const counter = find(".lr-counter");
  const navigation = find(".lr-navigation");
  const pageAlert = find(".lr-page-alert");
  const pageMessage = pageAlert.querySelector("span");
  const pageRetry = pageAlert.querySelector("button");
  const numberInput = find("#lr-page-number");
  const status = find(".lr-status");
  const progress = find("progress");
  const highlightedList = find(".lr-highlights-list");
  const selectionMenu = find(".lr-selection");
  const colors = find(".lr-colors");
  const colorToggle = find("[data-highlight-toggle]");

  displayTitle(book.title);
  if (book.source?.startsWith("https://pt.wikisource.org/wiki/")) {
    const source = find(".lr-source");
    source.href = book.source;
    source.hidden = false;
    navigation.classList.add("lr-navigation-with-source");
  }
  root.replaceChildren(element);

  function displayTitle(title) {
    find(".lr-title").textContent = title;
    find(".lr-title").title = title;
  }

  function announce(message) {
    if (signal.aborted) return;
    clearTimeout(notificationTimer);
    status.textContent = message;
    notificationTimer = setTimeout(() => { status.textContent = ""; }, 4600);
  }

  function displayPreferences(persist = false) {
    element.style.setProperty("--lr-text-size", `${preferences.size / 16}rem`);
    find(".lr-size-value").textContent = preferences.size;
    find("#lr-language").value = preferences.target;
    find("[data-size='-1']").disabled = preferences.size <= 15;
    find("[data-size='1']").disabled = preferences.size >= 33;
    if (persist) {
      try {
        localStorage.setItem(readingSettingsKey, JSON.stringify(preferences));
      } catch {
        announce("As preferências valem até fechar esta aba.");
      }
    }
  }

  function displayCounter() {
    const total = pageTotal();
    const current = displayed ? page + 1 : total === 0 ? 0 : "–";
    const suffix = displayed && parts.length > 1 ? partSuffix(part) : "";
    const label = suffix ? `Página ${current}, parte ${part + 1} de ${parts.length}` : `Página ${current}`;
    counter.textContent = `${current}${suffix} / ${total ?? "…"}`;
    counter.setAttribute("aria-label", `${label}${total === null ? "" : ` de ${total} páginas`}. ${controlsOpen ? "Ocultar" : "Mostrar"} controles de leitura`);
  }

  function showControls(open, moveFocus = false) {
    clearTimeout(tapTimer);
    const focused = document.activeElement;
    const focusInControls = header.contains(focused) || navigation.contains(focused) ||
      (activePanel && find(`[data-panel="${activePanel}"]`).contains(focused));
    controlsOpen = open;
    header.hidden = !open;
    navigation.hidden = !open;
    counter.setAttribute("aria-expanded", String(open));
    displayCounter();
    if (!open) {
      showPanel(null);
      if (focusInControls) counter.focus({ preventScroll: true });
    } else if (moveFocus) {
      find(".lr-back").focus({ preventScroll: true });
    }
  }

  function showPanel(name, restoreFocus = false) {
    const previous = activePanel;
    activePanel = name;
    for (const panel of element.querySelectorAll("[data-panel]")) {
      panel.hidden = panel.dataset.panel !== name;
    }
    for (const trigger of element.querySelectorAll("[data-toggle]")) {
      trigger.setAttribute("aria-expanded", String(trigger.dataset.toggle === name));
      if (restoreFocus && trigger.dataset.toggle === previous) trigger.focus();
    }
  }

  function hideSelection() {
    selectionData = null;
    selectionMenu.hidden = true;
    colors.hidden = true;
    colorToggle.setAttribute("aria-expanded", "false");
    if (highlightRepaintPending && !hasReadingSelection()) displayPage();
  }

  function hasReadingSelection() {
    const selection = window.getSelection();
    return Boolean(touchRange || (selection?.rangeCount && !selection.isCollapsed &&
      (article.contains(selection.anchorNode) || article.contains(selection.focusNode))));
  }

  function clearSelection() {
    touchControls?.clear();
    touchRange = null;
    window.getSelection()?.removeAllRanges();
    hideSelection();
  }

  function pageTotal() {
    if (Number.isInteger(knownCount) && knownCount > 0) return knownCount;
    return loading ? null : pages.length;
  }

  function canOpen(index) {
    const total = pageTotal();
    return Number.isInteger(index) && index >= 0 && Boolean(pages[index] || (loadPage && total !== null && index < total));
  }

  function displayLoading() {
    const indicator = find(".lr-loading");
    indicator.hidden = !loading;
    if (!loading) return;

    const stopped = loading.status === "error";
    const percent = Number.isFinite(loading.percent) ? Math.round(Math.max(0, Math.min(100, loading.percent))) : null;
    const label = stopped ? "Importação pausada" : "Importando";
    indicator.textContent = percent === null ? label : `${label} ${percent}%`;
    indicator.title = loading.phase || label;
    indicator.setAttribute("aria-label", indicator.title);
    if (percent === null) indicator.removeAttribute("aria-valuenow");
    else indicator.setAttribute("aria-valuenow", String(percent));
  }

  function displayNavigation() {
    const total = pageTotal();
    const current = displayed ? page + 1 : 0;
    find(".lr-page-total").textContent = `de ${total ?? "…"}`;
    find('[data-step="-1"]').disabled = !displayed || (part === 0 && !canOpen(page - 1));
    find('[data-step="1"]').disabled = !displayed || (part === parts.length - 1 && !canOpen(page + 1));
    if (document.activeElement !== numberInput) numberInput.value = current;
    numberInput.disabled = !displayed;
    progress.max = Math.max(total ?? pages.length, 1);
    progress.value = current;
    const percentage = find(".lr-percent");
    percentage.textContent = total ? `${Math.round(current / total * 100)}%` : "";
    displayCounter();
  }

  function displayPage() {
    highlightRepaintPending = false;
    const blocks = document.createDocumentFragment();
    const pageHighlights = highlights.filter((item) => item.page === page);

    for (const slice of parts[part]) {
      const block = displayed?.blocks[slice.block];
      if (block?.type === "text") {
        const paragraph = document.createElement("p");
        paragraph.dataset.readerBlock = slice.block;
        paragraph.dataset.readerStart = slice.start;
        const text = block.text.slice(slice.start, slice.end);
        const annotations = pageHighlights
          .filter((item) => item.block === slice.block && item.start < slice.end && item.end > slice.start)
          .map((item) => ({
            ...item,
            start: Math.max(0, item.start - slice.start),
            end: Math.min(text.length, item.end - slice.start),
          }));
        showAnnotations(paragraph, text, annotations);
        blocks.append(paragraph);
      }
      if (block?.type === "image") {
        const figure = document.createElement("figure");
        const image = document.createElement("img");
        image.src = block.src;
        image.alt = block.alt || `Ilustração da página ${page + 1}`;
        image.decoding = "async";
        image.width = slice.width;
        image.height = slice.height;
        figure.append(image);
        blocks.append(figure);
      }
    }

    if (displayed && !blocks.hasChildNodes()) {
      const empty = document.createElement("p");
      empty.className = "lr-empty-page";
      empty.textContent = "Esta página não tem conteúdo para exibir.";
      blocks.append(empty);
    }

    article.replaceChildren(blocks);
    const partLabel = parts.length > 1 ? `, parte ${part + 1} de ${parts.length}` : "";
    article.setAttribute("aria-label", displayed ? `Página ${page + 1}${partLabel}` : "Página de leitura");
    displayNavigation();
  }

  function layoutFor(index, source) {
    const previous = layouts.get(index);
    if (previous?.source === source) return previous.promise;
    const pending = { source, promise: paginatePage(source.blocks, article, { signal: layoutController.signal }) };
    layouts.set(index, pending);
    void pending.promise.catch(() => {
      if (layouts.get(index) === pending) layouts.delete(index);
    });
    return pending.promise;
  }

  function cancelPageLoad() {
    const active = pageLoad;
    pageLoad = null;
    active?.controller.abort();
  }

  function requestPage(index) {
    if (pageLoad?.index === index) return pageLoad.promise;
    const controller = new AbortController();
    const loader = loadPage;
    const promise = Promise.resolve().then(() => loader(index, controller.signal)).then((source) => {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (!Array.isArray(source?.blocks)) throw new Error("Página inválida.");
      pages[index] = source;
      return source;
    }).finally(() => {
      if (pageLoad?.controller === controller) pageLoad = null;
    });
    pageLoad = { index, controller, promise };
    return promise;
  }

  function showPageAlert(message, retry = null) {
    retryPage = retry;
    pageAlert.hidden = !message;
    pageMessage.textContent = message;
    pageRetry.hidden = !retry;
    if (message) status.textContent = "";
  }

  async function goTo(index, destination, { last = false, persist = true } = {}) {
    if (!canOpen(index)) {
      const total = pageTotal();
      if (persist && index >= 0 && (total === null || index < total)) {
        announce(loading ? "Esta página ainda está sendo importada." : "Esta página está indisponível.");
      }
      return;
    }
    const ticket = ++request;
    if (pageLoad && pageLoad.index !== index) cancelPageLoad();
    const cached = pages[index];
    showPageAlert(!cached || (!displayed && !loading) ? `Carregando página ${index + 1}…` : "");
    article.setAttribute("aria-busy", "true");
    try {
      const source = cached ?? await requestPage(index);
      if (ticket !== request || signal.aborted) return;
      const nextParts = await layoutFor(index, source);
      if (ticket !== request || signal.aborted) return;
      const nextPart = last ? nextParts.length - 1 : partAt(nextParts, destination);
      const nextAnchor = destination ?? firstAnchor(nextParts[nextPart]);
      const moved = page !== index || anchor?.block !== nextAnchor.block || anchor?.offset !== nextAnchor.offset;

      clearTimeout(tapTimer);
      highlightRepaintPending = false;
      clearSelection();
      page = index;
      part = nextPart;
      parts = nextParts;
      anchor = nextAnchor;
      displayed = source;
      displayPage();
      showPageAlert("");
      if (persist && moved) {
        positionUpdates = positionUpdates
          .then(() => onPosition(index, nextAnchor))
          .catch(() => announce("Não foi possível salvar sua posição."));
      }
    } catch {
      if (ticket === request && !signal.aborted) {
        showPageAlert(`Não foi possível abrir a página ${index + 1}.`, { index, destination, last, persist });
      }
    } finally {
      if (ticket === request) article.removeAttribute("aria-busy");
    }
  }

  function step(delta) {
    if (!displayed) return;
    const nextPart = part + delta;
    if (parts[nextPart]) {
      void goTo(page, firstAnchor(parts[nextPart]));
    } else {
      void goTo(page + delta, undefined, { last: delta < 0 });
    }
  }

  function reflow() {
    const size = `${article.clientWidth}:${article.clientHeight}:${preferences.size}`;
    if (size === layoutSize) return;
    layoutSize = size;
    layoutController.abort();
    layoutController = new AbortController();
    layouts.clear();
    void goTo(page, anchor, { persist: false });
  }

  function displayHighlights() {
    highlightedList.replaceChildren();
    if (!highlights.length) {
      const empty = document.createElement("p");
      empty.className = "lr-highlights-empty";
      empty.textContent = "Selecione um trecho no texto para criar seu primeiro destaque.";
      highlightedList.append(empty);
      return;
    }

    const entries = [...highlights].sort((left, right) =>
      left.page - right.page || left.block - right.block || left.start - right.start,
    );
    for (const item of entries) {
      const entry = document.createElement("div");
      entry.className = "lr-highlight-entry";
      entry.dataset.color = item.color;
      const jump = document.createElement("button");
      jump.type = "button";
      jump.className = "lr-highlight-jump";
      const label = document.createElement("small");
      label.textContent = `Página ${item.page + 1}`;
      const excerpt = document.createElement("span");
      excerpt.textContent = item.text;
      jump.append(label, excerpt);
      jump.addEventListener("click", () => {
        void goTo(item.page, { block: item.block, offset: item.start });
        showPanel(null, true);
      });

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "lr-remove-highlight";
      remove.setAttribute("aria-label", `Remover destaque na página ${item.page + 1}`);
      remove.innerHTML = icon("trash");
      remove.addEventListener("click", async () => {
        remove.disabled = true;
        try {
          await onRemoveHighlight(item.id);
          if (signal.aborted) return;
          removedHighlights.add(item.id);
          highlights = highlights.filter((highlight) => highlight.id !== item.id);
          clearSelection();
          displayPage();
          displayHighlights();
          find('[data-panel="highlights"] .lr-panel-close').focus();
          announce("Destaque removido.");
        } catch {
          remove.disabled = false;
          announce("Não foi possível remover este destaque.");
        }
      });
      entry.append(jump, remove);
      highlightedList.append(entry);
    }
  }

  function positionSelection(rect) {
    const inset = 8;
    const { offsetWidth: width, offsetHeight: height } = selectionMenu;
    const left = Math.min(window.innerWidth - width - inset, Math.max(inset, rect.left + rect.width / 2 - width / 2));
    const above = rect.top - height - inset;
    const below = rect.bottom + (touchRange ? 38 : inset);
    const limit = window.innerHeight - height - inset;
    const top = above >= inset ? above : below <= limit ? below : inset;
    selectionMenu.style.left = `${Math.max(inset, left)}px`;
    selectionMenu.style.top = `${Math.max(inset, top)}px`;
  }

  function displaySelection(range) {
    const selection = window.getSelection();
    const selectedRange = range ?? (selection?.rangeCount ? selection.getRangeAt(0) : null);
    if (!selectedRange || selectedRange.collapsed) {
      hideSelection();
      return;
    }
    if (!article.contains(selectedRange.startContainer) || !article.contains(selectedRange.endContainer)) {
      hideSelection();
      return;
    }

    const fragments = selectionFragments(article, selectedRange);
    const selectedText = fragments.map(({ text }) => text).join("\n").trim();
    const rect = selectedRange.getBoundingClientRect();
    if (!fragments.length || !selectedText || rect.bottom < 0 || rect.top > window.innerHeight) {
      hideSelection();
      return;
    }

    if (!selectionData || selectionData.text !== selectedText) {
      colors.hidden = true;
      colorToggle.setAttribute("aria-expanded", "false");
    }
    selectionData = { page, fragments, rect, text: selectedText };
    const dictionaryTerm = selectedText.match(/[\p{L}\p{M}]+(?:[-’'][\p{L}\p{M}]+)*/u)?.[0] ?? selectedText;
    find("[data-dictionary]").href =
      `https://pt.wiktionary.org/w/index.php?${new URLSearchParams({ search: dictionaryTerm })}`;
    find("[data-translate]").href =
      `https://translate.google.com/?${new URLSearchParams({ sl: "auto", tl: preferences.target, text: selectedText.slice(0, 5000), op: "translate" })}`;
    selectionMenu.hidden = false;
    positionSelection(rect);
  }

  find(".lr-back").addEventListener("click", onExit, { signal });
  pageRetry.addEventListener("click", () => {
    if (!retryPage) return;
    const { index, destination, last, persist } = retryPage;
    void goTo(index, destination, { last, persist });
  }, { signal });
  counter.addEventListener("click", (event) => {
    if (event.detail === 0) showControls(!controlsOpen, true);
  }, { signal });
  element.addEventListener("click", async (event) => {
    const pageStep = event.target.closest("[data-step]");
    if (pageStep) step(Number(pageStep.dataset.step));

    const trigger = event.target.closest("[data-toggle]");
    if (trigger) showPanel(activePanel === trigger.dataset.toggle ? null : trigger.dataset.toggle);
    if (event.target.closest(".lr-panel-close")) showPanel(null, true);

    const size = event.target.closest("[data-size]");
    if (size) {
      preferences = { ...preferences, size: preferences.size + Number(size.dataset.size) };
      displayPreferences(true);
      reflow();
    }
    if (event.target.closest("[data-highlight-toggle]") && selectionData) {
      colors.hidden = !colors.hidden;
      colorToggle.setAttribute("aria-expanded", String(!colors.hidden));
      positionSelection(selectionData.rect);
    }

    const colorChoice = event.target.closest(".lr-colors [data-color]");
    if (!colorChoice || !selectionData) return;

    const { page: markedPage, fragments } = selectionData;
    const color = colorChoice.dataset.color;
    clearSelection();
    const results = await Promise.allSettled(fragments.map((fragment) =>
      Promise.resolve().then(() => onAddHighlight({ ...fragment, page: markedPage, color })),
    ));
    if (signal.aborted) return;

    const saved = results.flatMap((result) => result.status === "fulfilled" && result.value?.id ? [result.value] : []);
    highlights.push(...saved);
    if (page === markedPage) {
      clearSelection();
      displayPage();
    }
    displayHighlights();
    if (saved.length === fragments.length) {
      announce("Destaque salvo.");
    } else {
      announce(saved.length ? "Parte do destaque foi salva." : "Não foi possível salvar o destaque.");
    }
  }, { signal });

  find("#lr-language").addEventListener("change", (event) => {
    preferences = { ...preferences, target: event.target.value };
    displayPreferences(true);
  }, { signal });

  function jumpFromInput() {
    const input = numberInput.value;
    numberInput.value = displayed ? page + 1 : 0;
    if (/^\d+$/.test(input)) void goTo(Number(input) - 1);
  }

  find(".lr-page-form").addEventListener("submit", (event) => {
    event.preventDefault();
    jumpFromInput();
    numberInput.blur();
  }, { signal });
  numberInput.addEventListener("change", jumpFromInput, { signal });
  numberInput.addEventListener("focus", () => numberInput.select(), { signal });

  function tapFraction(x) {
    const bounds = scroll.getBoundingClientRect();
    return (x - bounds.left) / bounds.width;
  }

  touchControls = installReaderTouch(scroll, {
    article,
    signal,
    onSwipe: step,
    onTap(x, target) {
      if (!(target instanceof Element) || target.closest("a, button, input") || !selectionMenu.hidden) return;
      const fraction = tapFraction(x);
      if (fraction >= 0.25 && fraction <= 0.75) showControls(!controlsOpen);
    },
    onSelection(range) {
      clearTimeout(selectionTimer);
      touchRange = range;
      if (range) displaySelection(range);
      else hideSelection();
    },
  });

  scroll.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.pointerType === "touch") return;
    tap = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      blocked: Boolean(activePanel) || !selectionMenu.hidden || !window.getSelection()?.isCollapsed,
    };
  }, { signal });

  scroll.addEventListener("pointermove", (event) => {
    if (tap?.id === event.pointerId &&
        Math.hypot(event.clientX - tap.x, event.clientY - tap.y) > 10) {
      tap.blocked = true;
    }
  }, { signal, passive: true });

  scroll.addEventListener("pointercancel", () => {
    if (tap) tap.blocked = true;
  }, { signal });

  scroll.addEventListener("click", (event) => {
    clearTimeout(tapTimer);
    const gesture = tap;
    tap = null;
    if (event.pointerType === "touch" || event.sourceCapabilities?.firesTouchEvents || scroll.dataset.input === "touch" ||
        event.defaultPrevented || event.button !== 0 || event.detail > 1 || gesture?.blocked ||
        !selectionMenu.hidden || !window.getSelection()?.isCollapsed ||
        event.target.closest("a, button, input")) return;

    const fraction = tapFraction(event.clientX);
    if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) return;
    const readText = event.target.closest("[data-reader-block]");
    if (fraction < 0.25 || fraction > 0.75) {
      if (!readText) step(fraction > 0.75 ? 1 : -1);
      return;
    }
    if (readText) {
      tapTimer = setTimeout(() => {
        if (window.getSelection()?.isCollapsed) showControls(!controlsOpen);
      }, 240);
    } else {
      showControls(!controlsOpen);
    }
  }, { signal });

  selectionMenu.addEventListener("mousedown", (event) => event.preventDefault(), { signal });
  // After a drag or swipe, the browser can skip the click from the next tap.
  for (const popup of [selectionMenu, pageAlert]) {
    popup.addEventListener("pointerdown", (event) => {
      if (event.pointerType !== "touch") return;
      const control = event.target.closest("button, a");
      if (!control) return;
      event.preventDefault();
      menuTap = { control, id: event.pointerId, x: event.clientX, y: event.clientY };
    }, { signal });
    popup.addEventListener("pointerup", (event) => {
      if (event.pointerId !== menuTap?.id) return;
      const { control, x, y } = menuTap;
      menuTap = null;
      if (!control.contains(event.target) || Math.hypot(event.clientX - x, event.clientY - y) > 12) return;
      lastMenuTouch = { control, at: performance.now() };
      control.click();
    }, { signal });
    popup.addEventListener("pointercancel", () => { menuTap = null; }, { signal });
    popup.addEventListener("click", (event) => {
      if (!event.isTrusted || event.detail === 0 || !lastMenuTouch?.control.contains(event.target) ||
          performance.now() - lastMenuTouch.at > 450) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, { signal, capture: true });
  }
  scroll.addEventListener("contextmenu", (event) => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !article.contains(selection.anchorNode) ||
        !article.contains(selection.focusNode)) return;
    event.preventDefault();
    displaySelection();
  }, { signal });
  selectionMenu.addEventListener("click", (event) => {
    if (!event.target.closest("a")) return;
    clearSelection();
  }, { signal });

  document.addEventListener("selectionchange", () => {
    if (touchRange) return;
    if (!window.getSelection()?.isCollapsed) clearTimeout(tapTimer);
    clearTimeout(selectionTimer);
    selectionTimer = setTimeout(displaySelection, 70);
  }, { signal });

  document.addEventListener("pointerdown", (event) => {
    if (activePanel && event.target instanceof Element &&
        !event.target.closest("[data-panel], [data-toggle]")) showPanel(null);
  }, { signal });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (!selectionMenu.hidden) {
        clearSelection();
      } else if (activePanel) showPanel(null, true);
      else if (controlsOpen) showControls(false);
      return;
    }
    if (activePanel || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey ||
        (event.target instanceof Element && event.target.closest("input, textarea, select, [contenteditable]")) ||
        touchRange || !window.getSelection()?.isCollapsed) return;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      step(event.key === "ArrowRight" ? 1 : -1);
    }
  }, { signal });

  window.addEventListener("resize", reflow, { signal });
  const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(reflow);
  observer?.observe(article);

  displayPreferences();
  displayHighlights();
  displayLoading();
  displayPage();
  reflow();

  const cleanup = () => {
    controller.abort();
    layoutController.abort();
    cancelPageLoad();
    observer?.disconnect();
    clearTimeout(tapTimer);
    clearTimeout(selectionTimer);
    clearTimeout(notificationTimer);
  };
  cleanup.updateBook = ({
    pages: nextPages, pageCount, loading: nextLoading, title, highlights: nextHighlights,
    loadPage: nextLoader, additionalHighlights,
  }) => {
    if (signal.aborted) return;
    if (nextPages) pages = nextPages;
    if (pageCount !== undefined) knownCount = pageCount;
    if (nextLoading !== undefined) loading = nextLoading;
    if (nextLoader !== undefined) loadPage = nextLoader;
    if (title !== undefined) displayTitle(title);
    displayLoading();
    displayNavigation();
    if (nextHighlights) {
      highlights = [...nextHighlights];
      clearSelection();
      displayHighlights();
      displayPage();
    }
    if (additionalHighlights?.length) {
      const known = new Set([...highlights.map(({ id }) => id), ...removedHighlights]);
      const length = highlights.length;
      for (const mark of additionalHighlights) {
        if (known.has(mark.id)) continue;
        known.add(mark.id);
        highlights.push(mark);
      }
      if (highlights.length !== length) {
        displayHighlights();
        if (highlights.slice(length).some((mark) => mark.page === page)) {
          if (hasReadingSelection()) highlightRepaintPending = true;
          else displayPage();
        }
      }
    }
    if (displayed !== pages[page]) {
      void goTo(page, anchor, { persist: false });
    } else if (!displayed) {
      const first = pages.findIndex(Boolean);
      if (first >= 0) void goTo(first, undefined, { persist: false });
    }
  };
  return cleanup;
}
