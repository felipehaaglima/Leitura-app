import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'

const dist = new URL('../dist/', import.meta.url)
const chunks = JSON.parse(await readFile(new URL('.vite/manifest.json', dist), 'utf8'))
const webManifest = JSON.parse(await readFile(new URL('manifest.json', dist), 'utf8'))
const shell = new Set([
  'index.html', 'manifest.json', 'margem.svg', 'covers.webp', 'illustration.webp',
  'icons/margem-apple.png', ...webManifest.icons.map(icon => icon.src.slice(1)),
])
const visited = new Set()

function addChunk(key) {
  if (visited.has(key)) return
  visited.add(key)
  const { file, imports = [], dynamicImports = [], css = [], assets = [] } = chunks[key]
  for (const output of [file, ...css, ...assets]) shell.add(output)
  for (const imported of imports) addChunk(imported)
  for (const imported of dynamicImports) {
    // PDF processing also fetches OCR models and is independent of offline reading.
    if (imported !== 'src/pdf.js') addChunk(imported)
  }
}

addChunk('index.html')

const worker = await readFile(new URL('service-worker.js', import.meta.url), 'utf8')
const files = [...shell].sort()
const hash = createHash('sha256').update(worker)
const contents = await Promise.all(files.map(file => readFile(new URL(file, dist))))
files.forEach((file, index) => hash.update(file).update(contents[index]))
const version = hash.digest('hex').slice(0, 16)
const definitions = `const SHELL_VERSION = ${JSON.stringify(version)}\nconst SHELL_FILES = ${JSON.stringify(files.map(file => '/' + file))}\n`

await writeFile(new URL('service-worker.js', dist), definitions + worker)
