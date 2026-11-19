import './reader-touch.css'

const longPressDelay = 380
const tapTolerance = 11
const swipeDistance = 46

function caretAt(article, x, y) {
  const position = document.caretPositionFromPoint?.(x, y)
  const legacy = position ? null : document.caretRangeFromPoint?.(x, y)
  const node = position?.offsetNode ?? legacy?.startContainer
  const offset = position?.offset ?? legacy?.startOffset
  const target = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement
  const paragraph = target?.closest('[data-reader-block]')
  return paragraph && article.contains(paragraph) ? { node, offset, paragraph } : null
}

function textPoint(paragraph, offset) {
  const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT)
  while (walker.nextNode()) {
    const node = walker.currentNode
    if (offset <= node.length) return { node, offset }
    offset -= node.length
  }
  return { node: paragraph, offset: paragraph.childNodes.length }
}

function wordAt(caret) {
  const { paragraph, node, offset } = caret
  const prefix = document.createRange()
  prefix.selectNodeContents(paragraph)
  prefix.setEnd(node, offset)
  const textOffset = prefix.toString().length
  const text = paragraph.textContent
  for (const match of text.matchAll(/[\p{L}\p{M}\p{N}]+(?:[’'-][\p{L}\p{M}\p{N}]+)*/gu)) {
    const end = match.index + match[0].length
    if (match.index <= textOffset && textOffset <= end) {
      const startPoint = textPoint(paragraph, match.index)
      const endPoint = textPoint(paragraph, end)
      const range = document.createRange()
      range.setStart(startPoint.node, startPoint.offset)
      range.setEnd(endPoint.node, endPoint.offset)
      return range
    }
  }
  return null
}

export function installReaderTouch(surface, { article, signal, onSwipe, onTap, onSelection }) {
  const visual = document.createElement('div')
  visual.className = 'lr-touch-visual'
  visual.setAttribute('aria-hidden', 'true')
  surface.append(visual)

  let gesture
  let selection
  let pressTimer

  function paint(range) {
    const boxes = Array.from(range.getClientRects()).filter(rect => rect.width > 0 && rect.height > 0)
    const first = boxes[0]
    const last = boxes.at(-1)
    if (!first || !last) return
    const fragment = document.createDocumentFragment()
    for (const box of boxes) {
      const shade = document.createElement('span')
      shade.className = 'lr-touch-shade'
      Object.assign(shade.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` })
      fragment.append(shade)
    }
    for (const [edge, box] of [['start', first], ['end', last]]) {
      const handle = document.createElement('span')
      handle.className = 'lr-touch-handle'
      handle.dataset.selectionEdge = edge
      handle.style.left = `${edge === 'start' ? box.left : box.right}px`
      handle.style.top = `${box.bottom}px`
      fragment.append(handle)
    }
    visual.replaceChildren(fragment)
    selection = range
    onSelection(selection)
  }

  function clear() {
    clearTimeout(pressTimer)
    if (!selection) return
    selection = null
    visual.replaceChildren()
    onSelection(null)
  }

  function cancelGesture() {
    clearTimeout(pressTimer)
    gesture = null
  }

  function extend(event) {
    if (!selection) return
    // The handles sit below the text. Offset the dragged point to its text line.
    const y = event.clientY - (gesture.handle ? 14 : 0)
    visual.classList.add('lr-touch-measuring')
    const point = caretAt(article, event.clientX, y)
    visual.classList.remove('lr-touch-measuring')
    if (!point) return

    const range = gesture.base.cloneRange()
    const side = range.comparePoint(point.node, point.offset)
    if (gesture.handle === 'start' || (!gesture.handle && side < 0)) {
      range.setStart(point.node, point.offset)
    } else {
      range.setEnd(point.node, point.offset)
    }
    if (!range.collapsed) paint(range)
  }

  surface.addEventListener('pointerdown', event => {
    surface.dataset.input = event.pointerType
    if (event.pointerType !== 'touch') {
      cancelGesture()
      clear()
      return
    }
    if (!event.isPrimary) {
      cancelGesture()
      return
    }
    if (event.target.closest('a, button, input')) return
    event.preventDefault()
    if (!window.getSelection()?.isCollapsed) window.getSelection()?.removeAllRanges()
    const handle = event.target.closest('[data-selection-edge]')?.dataset.selectionEdge
    const hadSelection = Boolean(selection)
    if (hadSelection && !handle) clear()
    gesture = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      target: event.target,
      handle,
      moved: false,
      selecting: Boolean(handle),
      base: handle ? selection?.cloneRange() : null,
      hadSelection,
    }
    surface.setPointerCapture?.(event.pointerId)
    if (!handle && event.target.closest('[data-reader-block]')) {
      pressTimer = setTimeout(() => {
        if (!gesture || gesture.moved) return
        const point = caretAt(article, gesture.x, gesture.y)
        const word = point && wordAt(point)
        if (word) {
          gesture.selecting = true
          gesture.base = word
          paint(word)
        }
      }, longPressDelay)
    }
  }, { signal })

  surface.addEventListener('pointermove', event => {
    if (gesture?.id !== event.pointerId) return
    if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) < tapTolerance && !gesture.handle) return
    gesture.moved = true
    clearTimeout(pressTimer)
    if (gesture.selecting) extend(event)
  }, { signal })

  surface.addEventListener('pointerup', event => {
    if (gesture?.id !== event.pointerId) return
    const previous = gesture
    cancelGesture()
    if (previous.selecting) return
    const dx = event.clientX - previous.x
    const dy = event.clientY - previous.y
    if (!previous.hadSelection && Math.abs(dx) >= swipeDistance && Math.abs(dx) > 1.35 * Math.abs(dy)) {
      onSwipe(dx < 0 ? 1 : -1)
    } else if (!previous.moved && !previous.hadSelection && Math.hypot(dx, dy) < tapTolerance) {
      onTap(event.clientX, previous.target)
    }
  }, { signal })

  surface.addEventListener('pointercancel', cancelGesture, { signal })
  surface.addEventListener('contextmenu', event => {
    if (surface.dataset.input === 'touch') event.preventDefault()
  }, { signal })
  signal.addEventListener('abort', () => {
    cancelGesture()
    visual.remove()
  }, { once: true })

  return { clear }
}
