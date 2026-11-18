import { cp, mkdir } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const assets = [
  ...['cmaps', 'standard_fonts', 'wasm', 'iccs'].map(name => [
    `node_modules/pdfjs-dist/${name}/`,
    `public/pdf/${name}/`,
  ]),
  ...['eng', 'por'].map(language => [
    `node_modules/@tesseract.js-data/${language}/4.0.0_best_int/${language}.traineddata.gz`,
    `public/ocr/${language}.traineddata.gz`,
  ]),
]

await mkdir(new URL('public/ocr/', root), { recursive: true })
await mkdir(new URL('public/pdf/', root), { recursive: true })
await Promise.all(assets.map(([source, destination]) => (
  cp(new URL(source, root), new URL(destination, root), { recursive: true })
)))
