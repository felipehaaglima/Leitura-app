import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import './assets.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const children = [
  spawn(process.execPath, ['server/index.js'], { cwd: root, stdio: 'inherit' }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js', ...process.argv.slice(2)], {
    cwd: root,
    stdio: 'inherit',
  }),
]

function stop(code = 0) {
  process.exitCode = code
  children.forEach(child => child.kill())
}
for (const child of children) {
  child.once('exit', code => stop(code ?? 0))
  child.once('error', error => {
    console.error(error)
    stop(1)
  })
}
process.once('SIGTERM', () => stop())
process.once('SIGINT', () => stop())
