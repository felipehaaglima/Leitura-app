import { AnnotationMode, getDocument, GlobalWorkerOptions } from 'pdfjs-dist'
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { createWorker, OEM, PSM } from 'tesseract.js'
import ocrWorkerFile from 'tesseract.js/dist/worker.min.js?url'
import ocrCoreFile from 'tesseract.js-core/tesseract-core-lstm.wasm.js?url'

GlobalWorkerOptions.workerSrc = pdfWorker

export const MAX_PDF_BYTES = 80 * 1024 * 1024
const MAX_PAGES = 500
const MAX_CONTENT_BYTES = 45 * 1024 * 1024
const appAssets = new URL(import.meta.env.BASE_URL, window.location.origin)

function normalizedText(value) {
  return value.replace(/[\u0000\u00ad]/g, '').replace(/\s+/g, ' ').trim()
}

function textCharacters(text) {
  return (text.match(/[\p{L}\p{N}]/gu) ?? []).length
}

function inspectText(paragraphs) {
  const text = paragraphs.map(paragraph => paragraph.text).join(' ').normalize('NFC')
  const visible = text.replace(/\s/g, '')
  const characters = textCharacters(visible)
  const letters = (visible.match(/\p{L}/gu) ?? []).length
  const badGlyphs = (visible.match(/[\uFFFD\p{Co}\p{Cc}]/gu) ?? []).length
  const noisySymbols = (visible.match(/[*#|~`^\\]/g) ?? []).length
  const invalidEncoding = badGlyphs > 0 && (badGlyphs === visible.length || badGlyphs >= 3 && badGlyphs / visible.length >= 0.06)

  // A damaged character map can expose private glyphs or punctuation instead of text.
  if (invalidEncoding || noisySymbols >= 8 && noisySymbols / visible.length >= 0.65) {
    return { characters, visible: visible.length, wordCharacters: 0, suspect: true }
  }

  const words = text.match(/\p{L}[\p{L}\p{M}]*/gu) ?? []
  let latinLetters = 0
  let shortLetters = 0
  let singleLetters = 0
  let wordLetters = 0
  for (const word of words) {
    if (!/^[\p{Script=Latin}\p{M}]+$/u.test(word)) continue
    // Accents and case still count as ordinary vowels in a Latin-script word.
    const plain = word.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
    const length = [...plain].length
    latinLetters += length
    if (length <= 2) shortLetters += length
    if (length === 1) singleLetters++
    if (length >= 3 && /[aeiouyæœøı]/.test(plain) && !/(.)\1{3,}/u.test(plain)) wordLetters += length
  }

  const latinPage = latinLetters >= 16 && latinLetters >= letters * 0.85
  const fragmented = shortLetters >= latinLetters * 0.65 && singleLetters >= latinLetters * 0.23
  const noisy = noisySymbols >= 4 && noisySymbols / visible.length >= 0.12
  const sparse = characters / visible.length < 0.58
  const missingWords = latinLetters >= 45 && wordLetters < latinLetters * 0.10
  // Some broken maps output entirely printable text, often as isolated capitals
  // and symbols. Look for weak word structure and corroborating evidence.
  const suspect = latinPage && (missingWords || wordLetters < latinLetters * 0.42 && (fragmented || noisy || sparse))
  return { characters, visible: visible.length, wordCharacters: wordLetters + (letters - latinLetters), suspect }
}

function ocrRecovered(data, recognized, native) {
  const quality = inspectText(recognized)
  if (quality.suspect) return false
  if (native.suspect) {
    // Corrupted maps can emit several glyphs per real letter. Compare usable
    // recovery to a lower bound, so extra gibberish cannot win on length alone.
    const minimumCharacters = Math.max(4, Math.min(100, Math.ceil(native.visible * 0.14)))
    return data.confidence >= 55 && quality.characters >= minimumCharacters &&
      quality.wordCharacters >= Math.max(3, minimumCharacters * 0.50)
  }
  return data.confidence >= 42 && quality.characters > Math.max(3, native.characters)
}

function textLines(content, viewport) {
  const lines = []
  let line
  for (const item of content.items) {
    if (!('str' in item)) continue
    const [x, baseline] = viewport.convertToViewportPoint(item.transform[4], item.transform[5])
    const size = Math.max(1, item.height || Math.hypot(item.transform[2], item.transform[3]))
    const end = x + item.width
    const sameLine = line && Math.abs(line.baseline - baseline) < Math.max(2, line.size * 0.38)
    const changesColumn = line && (x < line.x - line.size || x > line.end + line.size * 4)
    if (item.str.trim()) {
      if (!sameLine || changesColumn) {
        line = { text: item.str, x, baseline, size, end }
        lines.push(line)
      } else {
        const gap = x - line.end
        const space = gap > line.size * 0.12 && !/^\s/.test(item.str) && !/\s$/.test(line.text)
        line.text += (space ? ' ' : '') + item.str
        line.end = Math.max(line.end, end)
        line.size = Math.max(line.size, size)
      }
    } else if (sameLine && item.str) {
      line.text += ' '
      line.end = Math.max(line.end, end)
    }
    if (item.hasEOL) line = null
  }
  return lines
}

function joinWrappedLines(lines) {
  let text = ''
  for (const line of lines) {
    const clean = line.trim()
    if (!clean) continue
    const continuesWord = /[\p{L}][-\u00ad]$/u.test(text) && /^\p{Ll}/u.test(clean)
    text += (text && !continuesWord ? ' ' : '') + clean
  }
  return normalizedText(text)
}

function digitalParagraphs(lines, viewport) {
  const paragraphs = []
  let group = []
  const flush = () => {
    if (!group.length) return
    const first = group[0]
    paragraphs.push({
      text: joinWrappedLines(group.map(line => line.text)),
      top: (first.baseline - first.size) / viewport.height,
    })
    group = []
  }
  for (const line of lines) {
    const previous = group.at(-1)
    if (previous) {
      const gap = line.baseline - previous.baseline
      const size = Math.max(previous.size, line.size)
      if (gap < size * 0.4 || gap > size * 1.9 ||
          Math.abs(previous.size - line.size) > size * 0.3 ||
          Math.abs(line.x - previous.x) > size * 1.7) flush()
    }
    group.push(line)
  }
  flush()
  return paragraphs.filter(paragraph => paragraph.text)
}

function canvasContext(width, height) {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.ceil(width))
  canvas.height = Math.max(1, Math.ceil(height))
  const context = canvas.getContext('2d')
  if (!context) throw new Error('O navegador não conseguiu preparar as imagens do PDF.')
  return { canvas, context }
}

async function renderPage(page, viewport, maxSize) {
  const scale = Math.min(4, maxSize / Math.max(viewport.width, viewport.height))
  const larger = page.getViewport({ scale })
  const { canvas } = canvasContext(larger.width, larger.height)
  await page.render({ canvas, viewport: larger, recordImages: true, annotationMode: AnnotationMode.DISABLE }).promise
  return canvas
}

function pageImages(coordinates = []) {
  const images = []
  for (let i = 0; i + 5 < coordinates.length; i += 6) {
    const [x1, y1, x2, y2, x3, y3] = coordinates.slice(i, i + 6)
    const x4 = x2 + x3 - x1
    const y4 = y2 + y3 - y1
    const left = Math.max(0, Math.min(x1, x2, x3, x4))
    const right = Math.min(1, Math.max(x1, x2, x3, x4))
    const top = Math.max(0, Math.min(y1, y2, y3, y4))
    const bottom = Math.min(1, Math.max(y1, y2, y3, y4))
    if (right - left < 0.024 || bottom - top < 0.024) continue
    const rect = { left, top, right, bottom }
    const overlapsMost = image => intersectionArea(image, rect) > 0.93 * area(image) && area(rect) < 1.1 * area(image)
    if (!images.some(overlapsMost)) images.push(rect)
  }
  return images
}

const wholePage = { left: 0, top: 0, right: 1, bottom: 1 }

function area(rect) {
  return (rect.right - rect.left) * (rect.bottom - rect.top)
}

function intersectionArea(a, b) {
  return Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
    Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top))
}

function imageData(canvas, { left, top, right, bottom }, maxSize = 1200) {
  const x = Math.max(0, Math.floor(left * canvas.width))
  const y = Math.max(0, Math.floor(top * canvas.height))
  const width = Math.min(canvas.width, Math.ceil(right * canvas.width)) - x
  const height = Math.min(canvas.height, Math.ceil(bottom * canvas.height)) - y
  if (width <= 0 || height <= 0) return null
  const scale = Math.min(1, maxSize / Math.max(width, height))
  const crop = canvasContext(width * scale, height * scale)
  crop.context.drawImage(canvas, x, y, width, height, 0, 0, crop.canvas.width, crop.canvas.height)
  return crop.canvas.toDataURL('image/jpeg', 0.84)
}

function blocksForPage(paragraphs, images, canvas, pageNumber, fullPageFallback) {
  const blocks = paragraphs.map(({ text, top }) => ({ type: 'text', text, position: top }))
  for (const image of images) {
    const src = imageData(canvas, image)
    if (!src) continue
    const position = (image.top + image.bottom) / 2
    const alt = fullPageFallback ? `Página ${pageNumber} do PDF` : `Imagem da página ${pageNumber}`
    const next = blocks.findIndex(block => block.position > position)
    blocks.splice(next < 0 ? blocks.length : next, 0, { type: 'image', src, alt, position })
  }
  return blocks.map(({ position, ...block }) => block)
}

function sampledPage(canvas) {
  const scale = 180 / Math.max(canvas.width, canvas.height)
  const sample = canvasContext(canvas.width * scale, canvas.height * scale)
  const { width, height } = sample.canvas
  sample.context.drawImage(canvas, 0, 0, width, height)
  return { width, height, pixels: sample.context.getImageData(0, 0, width, height).data }
}

function hasPageContent(sample) {
  const { width, height, pixels } = sample
  let ink = 0
  for (let i = 0; i < pixels.length; i += 4) {
    if ((pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3 < 210) ink++
  }
  return ink > width * height * 0.001
}

function ocrParagraphs(data, canvas) {
  const paragraphs = []
  for (const block of data.blocks ?? []) {
    for (const paragraph of block.paragraphs ?? []) {
      const text = joinWrappedLines((paragraph.lines ?? []).map(line => line.text))
        || normalizedText(paragraph.text ?? '')
      if (textCharacters(text) < 2 || paragraph.confidence < 26 || !paragraph.bbox) continue
      const { x0, y0, x1, y1 } = paragraph.bbox
      paragraphs.push({
        text, left: x0 / canvas.width, top: y0 / canvas.height,
        right: x1 / canvas.width, bottom: y1 / canvas.height,
      })
    }
  }
  if (!paragraphs.length && !data.blocks?.length) {
    for (const text of (data.text ?? '').split(/\n\s*\n/)) {
      const clean = joinWrappedLines(text.split('\n'))
      if (clean) paragraphs.push({ text: clean, top: 0 })
    }
  }
  return paragraphs
}

// Dense regions outside text boxes can be photos baked into a scan or vector artwork.
// Use coarse tiles so isolated specks and rules stay out of the reader.
function findIllustrations({ width, height, pixels }, paragraphs, existingImages) {
  const tileSize = 8
  const columns = Math.floor(width / tileSize)
  const rows = Math.floor(height / tileSize)
  const occupied = new Set()
  const tileRect = (x, y) => ({
    left: x * tileSize / width, top: y * tileSize / height,
    right: (x + 1) * tileSize / width, bottom: (y + 1) * tileSize / height,
  })
  const excluded = [...paragraphs.filter(paragraph => paragraph.bottom !== undefined), ...existingImages]
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < columns; x++) {
      const rect = tileRect(x, y)
      if (excluded.some(region => intersectionArea(rect, region) > area(rect) * 0.12)) continue
      let marked = 0
      for (let j = y * tileSize; j < (y + 1) * tileSize; j++) {
        for (let i = x * tileSize; i < (x + 1) * tileSize; i++) {
          const offset = (j * width + i) * 4
          const red = pixels[offset]
          const green = pixels[offset + 1]
          const blue = pixels[offset + 2]
          if ((red + green + blue) / 3 < 164 || Math.max(red, green, blue) - Math.min(red, green, blue) > 33) marked++
        }
      }
      if (marked >= tileSize * tileSize * 0.38) occupied.add(y * columns + x)
    }
  }
  const illustrations = []
  for (const first of occupied) {
    const queue = [first]
    occupied.delete(first)
    let left = first % columns
    let top = Math.floor(first / columns)
    let right = left
    let bottom = top
    for (const tile of queue) {
      const x = tile % columns
      const y = Math.floor(tile / columns)
      left = Math.min(left, x)
      top = Math.min(top, y)
      right = Math.max(right, x)
      bottom = Math.max(bottom, y)
      const neighbors = []
      if (x > 0) neighbors.push(tile - 1)
      if (x + 1 < columns) neighbors.push(tile + 1)
      if (y > 0) neighbors.push(tile - columns)
      if (y + 1 < rows) neighbors.push(tile + columns)
      for (const next of neighbors) if (occupied.delete(next)) queue.push(next)
    }
    const tileArea = (right - left + 1) * (bottom - top + 1)
    if (queue.length < 7 || right - left < 2 || bottom - top < 2 || queue.length / tileArea < 0.45) continue
    const start = tileRect(left, top)
    const end = tileRect(right, bottom)
    const rect = { left: start.left, top: start.top, right: end.right, bottom: end.bottom }
    const overlapsText = excluded.some(region => intersectionArea(rect, region) > area(rect) * 0.04)
    if (!overlapsText && area(rect) < 0.65) illustrations.push(rect)
  }
  return illustrations
}

async function startOcr(language, logger) {
  let rejectStartup
  const startupError = new Promise((_, reject) => { rejectStartup = reject })
  const workerPromise = createWorker(language, OEM.LSTM_ONLY, {
    workerPath: ocrWorkerFile,
    workerBlobURL: false,
    corePath: ocrCoreFile,
    langPath: new URL('ocr', appAssets).href,
    logger,
    errorHandler: rejectStartup,
  })
  const timeout = setTimeout(() => rejectStartup(new Error('Tempo limite do OCR.')), 45_000)
  try {
    const worker = await Promise.race([workerPromise, startupError])
    try {
      await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO, user_defined_dpi: '220' })
      return worker
    } catch (error) {
      await worker.terminate()
      throw error
    }
  } catch (error) {
    workerPromise.then(worker => worker.terminate()).catch(() => {})
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

export async function importPdf(file, { language = 'por+eng', onProgress = () => {} } = {}) {
  if (!file?.size || file.size > MAX_PDF_BYTES) throw new Error('Escolha um PDF de até 80 MB.')
  if (!/^(por|eng)(\+(por|eng))?$/.test(language)) throw new Error('Idioma de OCR inválido.')

  onProgress({ stage: 'opening', current: 0, total: 0 })
  const loading = getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    cMapUrl: new URL('pdf/cmaps/', appAssets).href,
    iccUrl: new URL('pdf/iccs/', appAssets).href,
    standardFontDataUrl: new URL('pdf/standard_fonts/', appAssets).href,
    wasmUrl: new URL('pdf/wasm/', appAssets).href,
    isEvalSupported: false,
    maxImageSize: 65_000_000,
    canvasMaxAreaInBytes: 48 * 1024 * 1024,
  })
  let ocrWorker
  let ocrUnavailable = false
  let current = 0
  let total = 0
  let thumbnail = null
  let contentSize = 0
  const fallbackPages = []
  const pages = []
  try {
    const pdf = await loading.promise
    total = pdf.numPages
    if (total > MAX_PAGES) throw new Error(`O PDF pode ter até ${MAX_PAGES} páginas.`)
    const meta = await pdf.getMetadata().catch(() => null)
    const rawTitle = [meta?.info?.Title, file.name?.replace(/\.pdf$/i, '')]
      .find(value => typeof value === 'string' && normalizedText(value))
    const title = normalizedText(rawTitle ?? 'PDF sem título').slice(0, 180)

    for (current = 1; current <= total; current++) {
      onProgress({ stage: 'extracting', current, total })
      const page = await pdf.getPage(current)
      let canvas
      try {
        const viewport = page.getViewport({ scale: 1 })
        const lines = textLines(await page.getTextContent(), viewport)
        let paragraphs = digitalParagraphs(lines, viewport)
        const native = inspectText(paragraphs)
        canvas = await renderPage(page, viewport, native.suspect || native.characters < 70 ? 1900 : 1350)
        if (current === 1) thumbnail = imageData(canvas, wholePage, 280)
        let images = pageImages(page.imageCoordinates ?? [])
        const scanImage = images.some(image => area(image) > 0.65)
        if (native.suspect || (native.characters < 70 && (native.characters < 4 || scanImage))) {
          const sample = sampledPage(canvas)
          const hasContent = hasPageContent(sample)
          if (native.suspect) {
            paragraphs = []
            if (!hasContent) throw new Error(`Não foi possível recuperar o texto nem a imagem da página ${current}.`)
          }
          if (hasContent && !ocrUnavailable) {
            onProgress({ stage: 'ocr', current, total })
            try {
              ocrWorker ??= await startOcr(language, ({ progress, status }) => {
                if (status === 'recognizing text') onProgress({ stage: 'ocr', current, total, fraction: progress })
              })
              const { data } = await ocrWorker.recognize(canvas, {}, { blocks: true, text: true })
              const recognized = ocrParagraphs(data, canvas)
              if (ocrRecovered(data, recognized, native)) {
                paragraphs = recognized
                images = images.filter(image => area(image) <= 0.65 &&
                  !paragraphs.some(paragraph => intersectionArea(image, paragraph) > area(image) * 0.25))
                images.push(...findIllustrations(sample, paragraphs, images))
              }
            } catch {
              // The source page stays readable if the browser cannot start its OCR worker.
              ocrUnavailable = true
            }
          }
          if (!paragraphs.length && hasContent && (native.suspect || !images.length)) images = [wholePage]
          if (!paragraphs.length && images.length) fallbackPages.push(current)
        } else {
          // Searchable scans already carry a text layer. Keep their text and recover figures.
          if (scanImage && lines.length > 4) images = images.filter(image => area(image) <= 0.65)
          const textBounds = lines.map(line => ({
            left: line.x / viewport.width, right: line.end / viewport.width,
            top: (line.baseline - line.size) / viewport.height, bottom: line.baseline / viewport.height,
          }))
          images.push(...findIllustrations(sampledPage(canvas), textBounds, images))
        }

        const blocks = blocksForPage(paragraphs, images, canvas, current, fallbackPages.at(-1) === current)
        const result = { blocks }
        contentSize += new Blob([JSON.stringify(result)]).size
        if (contentSize > MAX_CONTENT_BYTES) throw new Error('O conteúdo extraído ficou muito grande. Divida o PDF em arquivos menores.')
        pages.push(result)
      } finally {
        page.cleanup()
        if (canvas) canvas.width = canvas.height = 1
      }
    }
    if (!pages.some(page => page.blocks.length)) throw new Error('O PDF não contém texto ou imagens legíveis.')
    onProgress({ stage: 'complete', current: total, total })
    return { title, pages, thumbnail, fallbackPages }
  } catch (error) {
    if (error.name === 'PasswordException') throw new Error('Remova a senha do PDF antes de enviar o arquivo.')
    if (error.name === 'InvalidPDFException') throw new Error('O arquivo está corrompido ou não é um PDF válido.')
    throw error
  } finally {
    await Promise.allSettled([loading.destroy(), ocrWorker?.terminate()])
  }
}
