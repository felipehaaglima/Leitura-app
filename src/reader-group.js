import "./reader-group.css";
import { applyReaderColor } from "./reader-colors.js";

const pollInterval = 10_000;
const statuses = new Set(["unavailable", "none", "invited", "active"]);

function textElement(tag, className, text) {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  return element;
}

function memberName(member, viewerId) {
  return viewerId && member.id === viewerId ? "Você" : member.name || "Leitor";
}

function memberInitials(name) {
  const words = name.trim().split(/\s+/u);
  return [words[0], words.length > 1 ? words.at(-1) : ""]
    .map((word) => Array.from(word)[0] ?? "")
    .join("").toLocaleUpperCase("pt-BR");
}

function hasPosition(member) {
  return Number.isInteger(member.currentPage) && member.currentPage >= 0;
}

export function installReaderGroup({
  button, body, leftRail, rightRail, signal, viewerId, getPage, loadGroup,
  startGroup, respondGroup, comparePeer, onChange, onJump, announce,
}) {
  let loader = loadGroup;
  let group;
  let groupKey;
  let paintedKey;
  let railKey;
  let page = null;
  let timer;
  let pending;
  let mutating = false;
  let updateFailed = false;

  leftRail.setAttribute("aria-label", "Leitores mais atrás");
  rightRail.setAttribute("aria-label", "Leitores mais adiante");

  function isVisible() {
    return !signal.aborted && document.visibilityState === "visible" && Boolean(loader) && page !== null;
  }

  function renderRail(rail, peers) {
    rail.replaceChildren();
    rail.hidden = !peers.length;
    for (const peer of peers) {
      const name = memberName(peer, viewerId);
      const current = peer.currentPage + 1;
      const item = textElement("li", "lr-group-peer", "");
      item.title = `${name} · Página ${current}`;
      item.setAttribute("aria-label", `${name}, página ${current}`);
      const avatar = textElement("span", "lr-group-peer-avatar", memberInitials(name));
      const label = textElement("span", "lr-group-peer-name", name);
      const number = textElement("span", "lr-group-peer-page", current);
      avatar.setAttribute("aria-hidden", "true");
      label.setAttribute("aria-hidden", "true");
      number.setAttribute("aria-hidden", "true");
      item.append(avatar, label, number);
      rail.append(item);
    }
  }

  function renderRails() {
    const peers = group?.status === "active" && page !== null
      ? group.members.filter((member) => member.id !== viewerId && hasPosition(member))
      : [];
    const positioned = peers.map((member) => ({
      member, distance: comparePeer ? comparePeer(member) : member.currentPage - page,
    }));
    const nextKey = JSON.stringify([page, positioned]);
    if (railKey === nextKey) return;
    railKey = nextKey;
    const left = positioned.filter(({ distance }) => distance < 0).sort((a, b) => b.distance - a.distance);
    const right = positioned.filter(({ distance }) => distance > 0).sort((a, b) => a.distance - b.distance);
    renderRail(leftRail, left.map(({ member }) => member));
    renderRail(rightRail, right.map(({ member }) => member));
  }

  function actionButton(className, label, action) {
    const control = textElement("button", `lr-group-action ${className}`, label);
    control.type = "button";
    control.dataset.groupFocus = className;
    control.disabled = mutating;
    control.addEventListener("click", action);
    return control;
  }

  function renderActive() {
    const members = textElement("ul", "lr-group-members", "");
    for (const member of group.members) {
      const item = textElement("li", "lr-group-member", "");
      const position = hasPosition(member) ? `Página ${member.currentPage + 1}` : "Página indisponível";
      item.append(
        textElement("strong", "lr-group-member-name", memberName(member, viewerId)),
        textElement("span", "lr-group-member-page", position),
      );
      members.append(item);
    }
    const marks = (group.highlights ?? []).filter((mark) => mark.page === page);
    body.append(
      textElement("p", "lr-group-description", "Quem aceitou participar pode ver sua página atual e os destaques que você compartilha com o grupo."),
      textElement("h3", "lr-group-heading", "Participantes"),
      members,
      textElement("h3", "lr-group-heading", "Destaques nesta página"),
    );
    if (!marks.length) {
      body.append(textElement("p", "lr-group-description", "Nenhum destaque compartilhado nesta página."));
      return;
    }
    const list = textElement("ul", "lr-group-highlights", "");
    for (const mark of marks) {
      const item = textElement("li", "lr-group-highlight", "");
      applyReaderColor(item, mark.color);
      const jump = textElement("button", "lr-group-jump", "");
      jump.type = "button";
      jump.dataset.groupFocus = `mark-${mark.id}`;
      jump.append(
        textElement("small", "lr-group-author", `${memberName(mark.author ?? {}, viewerId)} · Página ${mark.page + 1}`),
        textElement("span", "lr-group-excerpt", mark.text),
      );
      jump.addEventListener("click", () => onJump(mark));
      item.append(jump);
      if (mark.note) item.append(textElement("p", "lr-group-note", mark.note));
      list.append(item);
    }
    body.append(list);
  }

  function render() {
    button.hidden = !loader;
    renderRails();
    const key = JSON.stringify([Boolean(loader), groupKey, page, mutating, updateFailed]);
    if (paintedKey === key) return;
    paintedKey = key;
    const focus = body.contains(document.activeElement) ? document.activeElement.dataset.groupFocus : null;
    body.replaceChildren();
    if (!loader) return;

    const actions = textElement("div", "lr-group-actions", "");
    if (group?.status === "active") {
      renderActive();
    } else if (group?.status === "invited") {
      body.append(textElement("p", "lr-group-description", "Você recebeu um convite. Se aceitar, o grupo poderá ver sua página atual e os destaques que você compartilhar."));
      if (respondGroup && group.id) {
        actions.append(
          actionButton("lr-group-accept", "Aceitar convite", () => void mutate(() => respondGroup(group.id, true))),
          actionButton("lr-group-decline", "Recusar", () => void mutate(() => respondGroup(group.id, false))),
        );
      }
    } else if (group?.status === "none") {
      body.append(textElement("p", "lr-group-description", "Convide quem tem uma cópia deste livro compartilhada pelo Margem. Cada pessoa decide se quer participar e compartilhar seu progresso."));
      if (startGroup) actions.append(actionButton("lr-group-start", "Iniciar leitura em grupo", () => void mutate(startGroup)));
    } else if (group?.status === "unavailable") {
      body.append(textElement("p", "lr-group-description", "A leitura em grupo fica disponível depois que alguém aceita compartilhar este livro pelo Margem."));
    } else if (!updateFailed) {
      body.append(textElement("p", "lr-group-description", "Buscando leitura em grupo…"));
    }

    if (mutating) {
      const message = textElement("p", "lr-group-description", "Aguarde…");
      message.setAttribute("role", "status");
      body.append(message);
    } else if (updateFailed) {
      const message = textElement("p", "lr-group-description", "Não foi possível atualizar a leitura em grupo.");
      message.setAttribute("role", "status");
      body.append(message);
      actions.append(actionButton("lr-group-retry", "Tentar novamente", () => void refresh()));
    }
    if (actions.childNodes.length) body.append(actions);
    if (focus) {
      [...body.querySelectorAll("[data-group-focus]")].find((control) => control.dataset.groupFocus === focus)
        ?.focus({ preventScroll: true });
    }
  }

  function stopLoading() {
    clearTimeout(timer);
    const request = pending;
    pending = null;
    request?.controller.abort();
  }

  function refresh() {
    if (!isVisible() || mutating) return;
    if (pending?.page === page) return pending.promise;
    stopLoading();
    const request = { page, controller: new AbortController() };
    pending = request;
    request.promise = (async () => {
      try {
        const result = await loader(request.page, request.controller.signal);
        if (pending !== request || !isVisible()) return;
        const next = {
          ...result,
          status: statuses.has(result?.status) ? result.status : "unavailable",
          members: Array.isArray(result?.members) ? result.members : [],
          highlights: Array.isArray(result?.highlights) ? result.highlights : [],
        };
        const key = JSON.stringify(next);
        updateFailed = false;
        if (key !== groupKey) {
          group = next;
          groupKey = key;
          onChange(group);
        }
        render();
      } catch {
        if (pending !== request || !isVisible()) return;
        updateFailed = true;
        render();
      } finally {
        if (pending === request) {
          pending = null;
          if (isVisible()) timer = setTimeout(refresh, pollInterval);
        }
      }
    })();
    return request.promise;
  }

  async function mutate(action) {
    if (mutating || signal.aborted) return;
    stopLoading();
    mutating = true;
    updateFailed = false;
    render();
    try {
      await action();
    } catch (error) {
      if (!signal.aborted) announce(error?.message || "Não foi possível atualizar a leitura em grupo.");
    } finally {
      mutating = false;
      if (!signal.aborted) {
        render();
        void refresh();
      }
    }
  }

  function showPage() {
    const current = getPage();
    if (page === current) {
      renderRails();
      return;
    }
    page = current;
    stopLoading();
    render();
    void refresh();
  }

  function setLoader(nextLoader) {
    if (loader === nextLoader) return;
    stopLoading();
    loader = nextLoader;
    groupKey = undefined;
    group = undefined;
    updateFailed = false;
    onChange({ status: "unavailable", members: [], highlights: [] });
    render();
    void refresh();
  }

  document.addEventListener("visibilitychange", () => {
    if (isVisible()) void refresh();
    else stopLoading();
  }, { signal });
  signal.addEventListener("abort", stopLoading, { once: true });
  showPage();
  render();
  return { refresh, setLoader, showPage };
}
