const graphemes = typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : null
const imageSizes = new WeakMap()

function imageSize(block) {
  let pending = imageSizes.get(block)
  if (!pending) {
    const image = new Image()
    image.src = block.src
    pending = image.decode().then(
      () => ({ width: image.naturalWidth, height: image.naturalHeight }),
      () => ({ width: 96, height: 40 }),
    )
    imageSizes.set(block, pending)
  }
  return pending
}

function fittedImage(size, width, height) {
  const scale = Math.min(1, width / size.width, height / size.height)
  return {
    width: Math.max(1, Math.floor(size.width * scale)),
    height: Math.max(1, Math.floor(size.height * scale)),
  }
}

function characterOffsets(text) {
  const offsets = [0]
  if (graphemes) {
    for (const { index, segment } of graphemes.segment(text)) offsets.push(index + segment.length)
  } else {
    let index = 0
    for (const character of text) {
      index += character.length
      offsets.push(index)
    }
  }
  return offsets
}

function longestPrefix(start, end, fits) {
  let low = start
  let high = Math.min(end, start + 128)
  while (fits(high)) {
    if (high === end) return end
    low = high
    high = Math.min(end, start + 2 * (high - start))
  }
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2)
    if (fits(middle)) low = middle
    else high = middle
  }
  return low
}

function wordBoundary(text, offsets, start, end) {
  const breakAfter = /[\s\-\u2010\u2013\u2014]/u
  if (/\s/u.test(text.slice(offsets[end], offsets[end + 1]))) return end
  // Keep a word intact whenever the previous break lies near the end of the space.
  // An unbroken word that is wider than the page still advances by whole graphemes.
  const floor = start + Math.ceil((end - start) * 0.6)
  for (let cut = end; cut >= floor; cut--) {
    if (offsets[cut] > offsets[start] && breakAfter.test(text.slice(offsets[cut - 1], offsets[cut]))) {
      return cut
    }
  }
  return end
}

function makeProbe(article) {
  const probe = article.cloneNode(false)
  probe.removeAttribute('id')
  probe.setAttribute('aria-hidden', 'true')
  Object.assign(probe.style, {
    position: 'fixed',
    top: '0',
    left: '0',
    margin: '0',
    minHeight: '0',
    height: 'auto',
    maxHeight: 'none',
    maxWidth: 'none',
    visibility: 'hidden',
    overflow: 'visible',
    pointerEvents: 'none',
    display: 'flow-root',
    boxSizing: 'border-box',
  })
  article.after(probe)
  return probe
}

async function prepareFont(probe) {
  if (!document.fonts) return
  const paragraph = document.createElement('p')
  paragraph.textContent = 'Leitura Áá Çç'
  probe.append(paragraph)
  const { fontStyle, fontWeight, fontSize, fontFamily } = getComputedStyle(paragraph)
  try {
    await document.fonts.load(`${fontStyle} ${fontWeight} ${fontSize} ${fontFamily}`, paragraph.textContent)
  } catch {
    // The browser's fallback font is still measurable after a font load fails.
  } finally {
    paragraph.remove()
  }
}

export async function paginatePage(blocks, article, { signal } = {}) {
  signal?.throwIfAborted()
  if (!article.isConnected) return [[]]
  const probe = makeProbe(article)
  try {
    const [sizes] = await Promise.all([
      Promise.all(blocks.map(block => block?.type === 'image' ? imageSize(block) : null)),
      prepareFont(probe),
    ])
    signal?.throwIfAborted()
    if (!article.isConnected) return [[]]
    const { width, height } = article.getBoundingClientRect()
    if (width <= 0 || height <= 0) return [[]]
    probe.style.width = `${width}px`

    const style = getComputedStyle(probe)
    const px = property => parseFloat(style[property]) || 0
    const contentWidth = width - px('paddingLeft') - px('paddingRight') - px('borderLeftWidth') - px('borderRightWidth')
    const contentHeight = height - px('paddingTop') - px('paddingBottom') - px('borderTopWidth') - px('borderBottomWidth')
    const bottom = probe.getBoundingClientRect().top + height - px('paddingBottom') - px('borderBottomWidth')
    const fits = node => node.getBoundingClientRect().bottom <= bottom + 0.01
    const pages = []
    let part = []

    function nextPart() {
      if (part.length) pages.push(part)
      part = []
      probe.replaceChildren()
    }

    for (const [index, block] of blocks.entries()) {
      signal?.throwIfAborted()
      if (block?.type === 'image') {
        const figure = document.createElement('figure')
        const image = document.createElement('img')
        const dimensions = fittedImage(sizes[index], contentWidth, contentHeight)
        image.width = dimensions.width
        image.height = dimensions.height
        figure.append(image)
        probe.append(figure)
        if (part.length && !fits(figure)) {
          nextPart()
          probe.append(figure)
        }
        part.push({ block: index, ...dimensions })
        continue
      }
      if (block?.type !== 'text' || !block.text?.trim()) continue

      const { text } = block
      const paragraph = document.createElement('p')
      paragraph.textContent = text
      probe.append(paragraph)
      if (fits(paragraph)) {
        part.push({ block: index, start: 0, end: text.length })
        continue
      }
      if (part.length && paragraph.getBoundingClientRect().height <= contentHeight + 0.01) {
        nextPart()
        probe.append(paragraph)
        part.push({ block: index, start: 0, end: text.length })
        continue
      }

      const offsets = characterOffsets(text)
      const last = offsets.length - 1
      let start = 0
      while (start < last) {
        const end = longestPrefix(start, last, candidate => {
          paragraph.textContent = text.slice(offsets[start], offsets[candidate])
          return fits(paragraph)
        })
        if (end === start && part.length) {
          nextPart()
          probe.append(paragraph)
          continue
        }
        const cut = end === last ? last : Math.max(start + 1, wordBoundary(text, offsets, start, end))
        paragraph.textContent = text.slice(offsets[start], offsets[cut])
        part.push({ block: index, start: offsets[start], end: offsets[cut] })
        start = cut
        if (start < last) {
          nextPart()
          probe.append(paragraph)
        }
      }
    }
    if (part.length) pages.push(part)
    return pages.length ? pages : [[]]
  } finally {
    probe.remove()
  }
}
