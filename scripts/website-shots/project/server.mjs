// The shop's dev server: serves the storefront's checkout page and logs each
// request, like a framework dev server would.
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'

const port = Number(process.env.PORT || 3000)
const page = readFileSync(new URL('./public/index.html', import.meta.url))

const server = createServer((req, res) => {
  const started = performance.now()
  const ok = req.url === '/' || req.url.startsWith('/checkout')
  res.writeHead(ok ? 200 : 404, { 'content-type': ok ? 'text/html; charset=utf-8' : 'text/plain' })
  res.end(ok ? page : 'Not found')
  const ms = Math.max(1, Math.round(performance.now() - started))
  console.log(`  ${req.method} ${req.url} ${ok ? '\x1b[32m200\x1b[0m' : '\x1b[33m404\x1b[0m'} in ${ms}ms`)
})

server.listen(port, '127.0.0.1', () => {
  console.log('\n  \x1b[1matelier-nord-shop\x1b[0m dev server\n')
  console.log(`  \x1b[36m➜\x1b[0m  Local:   http://localhost:${port}/checkout`)
  console.log('  \x1b[2m➜  Watching src/ for changes\x1b[0m\n')
})
