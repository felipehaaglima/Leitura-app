import "./highlight-panel.css";
import { applyReaderColor } from "./reader-colors.js";

const noteLimit = 2000;
const dateFormat = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" });

function textElement(tag, className, text) {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  return element;
}

function noteButton(label, action) {
  const button = textElement("button", "lr-hp-button", label);
  button.type = "button";
  button.dataset.hp = action;
  return button;
}

function noteDate(note) {
  const edited = note.updatedAt && note.updatedAt !== note.createdAt;
  const date = new Date(edited ? note.updatedAt : note.createdAt);
  if (Number.isNaN(date.valueOf())) return null;
  const time = textElement("time", "lr-hp-date", `${edited ? "Editada em " : ""}${dateFormat.format(date)}`);
  time.dateTime = date.toISOString();
  return time;
}

export function installHighlightPanel(root, {
  signal, loadNotes, addNote, updateNote, deleteNote, onRemoveHighlight,
  onUpdateHighlight, viewerId, getGroup = () => null, announce = () => {},
}) {
  const lifecycle = new AbortController();
  const dialog = document.createElement("dialog");
  dialog.className = "lr-hp";
  dialog.setAttribute("aria-labelledby", "lr-hp-title");
  dialog.innerHTML = `
    <header class="lr-hp-heading">
      <h2 id="lr-hp-title">Destaque</h2>
      <button type="button" class="lr-hp-button" data-hp="close" autofocus>Fechar</button>
    </header>
    <blockquote class="lr-hp-excerpt"></blockquote>
    <div class="lr-hp-meta">
      <p class="lr-hp-attribution"></p>
      <div class="lr-hp-actions">
        <button type="button" class="lr-hp-button" data-hp="visibility" hidden></button>
        <button type="button" class="lr-hp-button lr-hp-danger" data-hp="remove" hidden>Remover destaque</button>
      </div>
    </div>
    <p class="lr-hp-feedback" role="status" hidden></p>
    <p class="lr-hp-error" role="alert" hidden></p>
    <section class="lr-hp-confirm" aria-labelledby="lr-hp-confirm-text" hidden>
      <p id="lr-hp-confirm-text"></p>
      <div class="lr-hp-actions">
        <button type="button" class="lr-hp-button" data-hp="cancel-removal">Cancelar</button>
        <button type="button" class="lr-hp-button lr-hp-danger" data-hp="confirm-removal">Confirmar remoção</button>
      </div>
    </section>
    <section class="lr-hp-notes" aria-labelledby="lr-hp-notes-title">
      <div class="lr-hp-notes-heading">
        <h3 id="lr-hp-notes-title">Notas</h3>
        <button type="button" class="lr-hp-button" data-hp="new" hidden>Adicionar nota</button>
      </div>
      <p class="lr-hp-notes-status" role="status" hidden></p>
      <button type="button" class="lr-hp-button" data-hp="retry" hidden>Tentar novamente</button>
      <ul class="lr-hp-note-list"></ul>
    </section>
    <form class="lr-hp-composer" aria-labelledby="lr-hp-compose-title" hidden>
      <h3 id="lr-hp-compose-title"></h3>
      <label for="lr-hp-text">Nota</label>
      <textarea id="lr-hp-text" rows="4" maxlength="${noteLimit}" required
        aria-describedby="lr-hp-count"></textarea>
      <p id="lr-hp-count" class="lr-hp-count"></p>
      <label class="lr-hp-scope">Visibilidade da nota
        <select name="scope">
          <option value="private">Pessoal</option>
          <option value="group">Grupo</option>
        </select>
      </label>
      <p class="lr-hp-private">Nota pessoal</p>
      <div class="lr-hp-mentions" hidden>
        <label for="lr-hp-mention">Mencionar participante (@)</label>
        <select id="lr-hp-mention">
          <option value="">Selecione uma pessoa</option>
        </select>
        <ul class="lr-hp-mention-list" aria-label="Pessoas mencionadas"></ul>
      </div>
      <div class="lr-hp-actions">
        <button type="button" class="lr-hp-button" data-hp="cancel-draft">Cancelar</button>
        <button type="submit" class="lr-hp-button lr-hp-primary">Salvar nota</button>
      </div>
    </form>`;
  root.append(dialog);

  const find = selector => dialog.querySelector(selector);
  const control = name => find(`[data-hp=${name}]`);
  const excerpt = find(".lr-hp-excerpt");
  const attribution = find(".lr-hp-attribution");
  const confirm = find(".lr-hp-confirm");
  const list = find(".lr-hp-note-list");
  const notesStatus = find(".lr-hp-notes-status");
  const form = find(".lr-hp-composer");
  const message = find(".lr-hp-feedback");
  const errorMessage = find(".lr-hp-error");
  const textarea = find("#lr-hp-text");
  const scopeField = find(".lr-hp-scope");
  const scope = form.elements.scope;
  const mentionPane = find(".lr-hp-mentions");
  const mentionSelect = find("#lr-hp-mention");
  const mentionList = find(".lr-hp-mention-list");
  let state;

  function feedback(container, text = "") {
    container.textContent = text;
    container.hidden = !text;
  }

  function clearFeedback() {
    feedback(message);
    feedback(errorMessage);
  }

  function groupActive() {
    return getGroup()?.status === "active";
  }

  function mayShareNote() {
    return state?.mark.scope === "group" && groupActive();
  }

  function eligibleMembers() {
    return (getGroup()?.members ?? []).filter(member => member.id !== viewerId);
  }

  function refreshMentionOptions() {
    const draft = state.draft;
    const members = eligibleMembers();
    const options = members.filter(member => !draft.mentions.has(member.id));
    const key = JSON.stringify(options.map(({ id, name }) => [id, name]));
    if (draft.optionsKey !== key) {
      draft.optionsKey = key;
      mentionSelect.replaceChildren(new Option("Selecione uma pessoa", ""), ...options.map(member =>
        new Option(`@${member.name}`, member.id)));
    }

    const selected = members.filter(member => draft.mentions.has(member.id));
    const selectedKey = JSON.stringify(selected.map(({ id, name }) => [id, name]));
    if (draft.selectedKey !== selectedKey) {
      draft.selectedKey = selectedKey;
      const nodes = selected.map(member => {
        const item = document.createElement("li");
        const chip = noteButton(`@${member.name} ×`, "unmention");
        chip.classList.add("lr-hp-chip");
        chip.dataset.id = member.id;
        chip.setAttribute("aria-label", `Remover menção a ${member.name}`);
        item.append(chip);
        return item;
      });
      mentionList.replaceChildren(...nodes);
    }
    mentionSelect.disabled = state.mutating || !options.length;
    mentionList.querySelectorAll("button").forEach(button => { button.disabled = state.mutating; });
  }

  function updateComposer() {
    form.hidden = !state.draft;
    if (!state.draft) return;
    const allowGroup = mayShareNote();
    scopeField.hidden = !allowGroup;
    find(".lr-hp-private").hidden = allowGroup;
    if (!allowGroup) scope.value = "private";
    mentionPane.hidden = scope.value !== "group";
    if (!mentionPane.hidden) refreshMentionOptions();
    textarea.readOnly = state.mutating;
    scope.disabled = state.mutating;
    form.querySelector('button[type="submit"]').disabled = state.mutating;
    control("cancel-draft").disabled = state.mutating;
  }

  function updateAccess() {
    if (!state) return;
    const shared = state.mark.scope === "group";
    const label = shared ? "Grupo" : "Pessoal";
    feedback(attribution, state.readonly ? `${state.mark.author?.name || "Outro leitor"} · ${label}` : label);
    const canChange = !state.readonly && onUpdateHighlight && (shared || groupActive());
    const visibility = control("visibility");
    visibility.hidden = !canChange;
    visibility.textContent = shared ? "Tornar pessoal" : "Compartilhar com o grupo";
    visibility.disabled = state.mutating;
    const remove = control("remove");
    remove.hidden = state.readonly || !onRemoveHighlight;
    remove.disabled = state.mutating;
    const newNote = control("new");
    newNote.hidden = state.readonly || !addNote || Boolean(state.draft);
    newNote.disabled = state.mutating || state.loading;
    control("confirm-removal").disabled = state.mutating;
    control("cancel-removal").disabled = state.mutating;
    updateComposer();
  }

  function renderNote(note) {
    const item = document.createElement("li");
    item.className = "lr-hp-note";
    const meta = textElement("div", "lr-hp-note-meta", note.scope === "group" ? "Grupo" : "Pessoal");
    const time = noteDate(note);
    if (time) meta.append(time);
    item.append(meta, textElement("p", "lr-hp-note-text", note.text));
    if (note.scope === "group" && note.mentions?.length) {
      const mentions = document.createElement("ul");
      mentions.className = "lr-hp-mention-list";
      mentions.setAttribute("aria-label", "Pessoas mencionadas");
      mentions.append(...note.mentions.map(member => textElement("li", "lr-hp-chip", `@${member.name}`)));
      item.append(mentions);
    }
    if (!state.readonly && (updateNote || deleteNote)) {
      const actions = document.createElement("div");
      actions.className = "lr-hp-actions lr-hp-note-actions";
      if (updateNote) {
        const edit = noteButton("Editar nota", "edit");
        edit.dataset.id = note.id;
        edit.disabled = state.mutating || state.loading;
        actions.append(edit);
      }
      if (deleteNote) {
        const remove = noteButton("Remover nota", "remove-note");
        remove.dataset.id = note.id;
        remove.disabled = state.mutating || state.loading;
        actions.append(remove);
      }
      item.append(actions);
    }
    return item;
  }

  function renderNotes() {
    const notes = state.readonly ? state.notes.filter(note => note.scope === "group") : state.notes;
    list.replaceChildren(...notes.map(renderNote));
    feedback(notesStatus, state.loading ? "Carregando notas…" :
      state.notesFailed || notes.length ? "" : "Nenhuma nota neste destaque.");
    control("retry").hidden = !state.notesFailed;
    control("retry").disabled = state.mutating;
    updateAccess();
  }

  async function refreshNotes() {
    const session = state;
    if (!session || !loadNotes) return;
    session.request?.abort();
    const request = new AbortController();
    session.request = request;
    session.loading = true;
    session.notesFailed = false;
    renderNotes();
    try {
      const response = await loadNotes(session.mark.id, { signal: request.signal });
      if (state === session && !request.signal.aborted) {
        const notes = Array.isArray(response) ? response : response?.notes;
        session.notes = Array.isArray(notes) ? [...notes] : [];
      }
    } catch (error) {
      if (state === session && !request.signal.aborted) {
        session.notesFailed = true;
        feedback(errorMessage, error?.message || "Não foi possível carregar as notas.");
      }
    } finally {
      if (state === session && !request.signal.aborted) {
        session.loading = false;
        session.request = null;
        renderNotes();
      }
    }
  }

  function setConfirmation(type, noteId, trigger) {
    state.confirmation = { type, noteId, trigger };
    find("#lr-hp-confirm-text").textContent = type === "mark"
      ? "Remover este destaque e todas as notas dele?" : "Remover esta nota?";
    confirm.hidden = false;
    control("cancel-removal").focus();
  }

  function clearConfirmation(restoreFocus = false) {
    const trigger = state.confirmation?.trigger;
    state.confirmation = null;
    confirm.hidden = true;
    if (restoreFocus && trigger?.isConnected) trigger.focus({ preventScroll: true });
  }

  function updateCount() {
    find("#lr-hp-count").textContent = `${textarea.value.length} de ${noteLimit} caracteres`;
  }

  function openDraft(note, trigger) {
    clearConfirmation();
    clearFeedback();
    state.draft = { id: note?.id, trigger, mentions: new Set((note?.mentions ?? []).map(({ id }) => id)) };
    find("#lr-hp-compose-title").textContent = note ? "Editar nota" : "Nova nota";
    textarea.value = note?.text ?? "";
    scope.value = note?.scope === "group" ? "group" : "private";
    updateCount();
    updateAccess();
    textarea.focus();
  }

  function clearDraft(restoreFocus = false) {
    const trigger = state.draft?.trigger;
    state.draft = null;
    updateAccess();
    if (restoreFocus) (trigger?.isConnected ? trigger : control("new")).focus({ preventScroll: true });
  }

  async function mutate(action, success, fallback) {
    const session = state;
    if (!session || session.readonly || session.mutating) return;
    session.mutating = true;
    clearFeedback();
    updateAccess();
    list.querySelectorAll("button").forEach(button => { button.disabled = true; });
    try {
      const result = await action(session);
      if (state === session) {
        session.mutating = false;
        success(session, result);
      }
    } catch (error) {
      if (state === session) {
        feedback(errorMessage, error?.message || fallback);
        errorMessage.scrollIntoView({ block: "nearest" });
      }
    } finally {
      if (state === session) {
        session.mutating = false;
        updateAccess();
        list.querySelectorAll("button").forEach(button => { button.disabled = session.loading; });
      }
    }
  }

  function applyVisibility() {
    if (!onUpdateHighlight) return;
    const next = state.mark.scope === "group" ? "private" : "group";
    if (next === "group" && !groupActive()) return;
    void mutate(session => onUpdateHighlight(session.mark.id, { scope: next }), (session, result) => {
      session.mark = { ...session.mark, ...(result?.highlight ?? result), scope: next };
      updateAccess();
      feedback(message, next === "group" ? "Destaque compartilhado com o grupo." : "Destaque pessoal.");
      void refreshNotes();
    }, "Não foi possível mudar a visibilidade do destaque.");
  }

  function removeConfirmed() {
    const pending = state.confirmation;
    if (!pending) return;
    if (pending.type === "mark" && onRemoveHighlight) {
      void mutate(session => onRemoveHighlight(session.mark.id), () => {
        close();
        announce("Destaque removido.");
      }, "Não foi possível remover o destaque.");
    } else if (pending.type === "note" && deleteNote) {
      void mutate(session => deleteNote(session.mark.id, pending.noteId), session => {
        session.notes = session.notes.filter(note => note.id !== pending.noteId);
        if (session.draft?.id === pending.noteId) clearDraft();
        clearConfirmation();
        renderNotes();
        feedback(message, "Nota removida.");
        (control("new").hidden ? control("close") : control("new")).focus({ preventScroll: true });
      }, "Não foi possível remover a nota.");
    }
  }

  function close() {
    if (!state) return;
    const { trigger, request } = state;
    state = null;
    request?.abort();
    if (dialog.open) dialog.close();
    list.replaceChildren();
    excerpt.textContent = "";
    textarea.value = "";
    mentionList.replaceChildren();
    mentionSelect.replaceChildren();
    form.hidden = true;
    if (trigger?.isConnected) trigger.focus({ preventScroll: true });
  }

  function open(mark, { trigger = document.activeElement, readonly } = {}) {
    if (!mark?.id || lifecycle.signal.aborted) return;
    state?.request?.abort();
    state = {
      mark, trigger, readonly: readonly ?? Boolean(mark.author?.id && mark.author.id !== viewerId),
      notes: [], loading: false, notesFailed: false, mutating: false, draft: null, confirmation: null,
    };
    excerpt.textContent = mark.text;
    excerpt.removeAttribute("style");
    delete excerpt.dataset.color;
    applyReaderColor(excerpt, mark.color);
    confirm.hidden = true;
    clearFeedback();
    renderNotes();
    if (!dialog.open) dialog.showModal();
    control("close").focus({ preventScroll: true });
    void refreshNotes();
  }

  function updateGroup() {
    if (!state) return;
    const group = getGroup();
    const lostMembership = ["unavailable", "none", "invited"].includes(group?.status);
    const missingMark = group?.status === "active" && Array.isArray(group.highlights) &&
      !group.highlights.some(mark => mark.id === state.mark.id);
    if (state.readonly && state.mark.scope === "group" && (lostMembership || missingMark)) {
      close();
      announce("O destaque do grupo não está mais disponível.");
    } else {
      updateAccess();
    }
  }

  form.addEventListener("submit", event => {
    event.preventDefault();
    if (!state?.draft || state.mutating) return;
    const text = textarea.value.trim();
    if (!text) {
      feedback(errorMessage, "Escreva uma nota antes de salvar.");
      textarea.focus();
      return;
    }
    if (text.length > noteLimit) {
      feedback(errorMessage, `A nota pode ter até ${noteLimit} caracteres.`);
      return;
    }
    const noteScope = mayShareNote() && scope.value === "group" ? "group" : "private";
    const { id, mentions } = state.draft;
    const payload = {
      text, scope: noteScope,
      mentions: noteScope === "group" ? eligibleMembers().filter(member => mentions.has(member.id)).map(member => member.id) : [],
    };
    const save = id ? session => updateNote(session.mark.id, id, payload) : session => addNote(session.mark.id, payload);
    void mutate(save, (session, result) => {
      const note = result?.note ?? result;
      if (note?.id) session.notes = session.notes.some(existing => existing.id === note.id)
        ? session.notes.map(existing => existing.id === note.id ? note : existing)
        : [...session.notes, note];
      else void refreshNotes();
      clearDraft();
      renderNotes();
      feedback(message, "Nota salva.");
      (control("new").hidden ? control("close") : control("new")).focus({ preventScroll: true });
    }, "Não foi possível salvar a nota.");
  }, { signal: lifecycle.signal });

  textarea.addEventListener("input", updateCount, { signal: lifecycle.signal });
  scope.addEventListener("change", updateComposer, { signal: lifecycle.signal });
  mentionSelect.addEventListener("change", () => {
    if (!state?.draft || !mentionSelect.value || !mayShareNote()) return;
    state.draft.mentions.add(mentionSelect.value);
    refreshMentionOptions();
    mentionSelect.value = "";
  }, { signal: lifecycle.signal });

  dialog.addEventListener("click", event => {
    const button = event.target.closest("button[data-hp]");
    if (!button || button.disabled || !state) return;
    const { hp, id } = button.dataset;
    if (hp === "close") close();
    else if (hp === "retry") {
      clearFeedback();
      void refreshNotes();
    } else if (!state.readonly) {
      if (hp === "visibility") applyVisibility();
      else if (hp === "remove") setConfirmation("mark", null, button);
      else if (hp === "remove-note") setConfirmation("note", id, button);
      else if (hp === "cancel-removal") clearConfirmation(true);
      else if (hp === "confirm-removal") removeConfirmed();
      else if (hp === "new") openDraft(null, button);
      else if (hp === "edit") openDraft(state.notes.find(note => note.id === id), button);
      else if (hp === "cancel-draft") clearDraft(true);
      else if (hp === "unmention" && state.draft) {
        state.draft.mentions.delete(id);
        refreshMentionOptions();
        mentionSelect.focus({ preventScroll: true });
      }
    }
  }, { signal: lifecycle.signal });

  dialog.addEventListener("keydown", event => event.stopPropagation(), { signal: lifecycle.signal });
  dialog.addEventListener("cancel", event => {
    event.preventDefault();
    event.stopPropagation();
    close();
  }, { signal: lifecycle.signal });
  dialog.addEventListener("close", () => {
    if (!dialog.open) close();
  }, { signal: lifecycle.signal });

  function cleanup() {
    if (state) state.trigger = null;
    close();
    lifecycle.abort();
    signal?.removeEventListener("abort", cleanup);
    dialog.remove();
  }

  if (signal?.aborted) cleanup();
  else signal?.addEventListener("abort", cleanup, { once: true });
  return { open, close, updateGroup, cleanup, get isOpen() { return dialog.open; } };
}
