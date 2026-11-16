/**
 * The host every `slideless dev` child runs under (PRDCT-4472): a preview
 * must end when the server that started it ends, whatever ended that server.
 * On 12 November 2026 seventeen previews were found alive on one machine,
 * two days after the test servers that started them had gone: a SIGKILL or
 * a crash runs no cleanup, so nothing told them.
 *
 * The cure needs no cleanup in the server. The server starts the preview
 * through this small module with its input as a pipe it holds open and never
 * writes to. When the server's process ends, however it ends, the operating
 * system closes its end of the pipe, the child reads the end of its input,
 * and exits. The Slideless command line is an ES module, so the host is one
 * too, and it imports the command line after taking itself out of `argv`, so
 * the command line reads its arguments as if it had been run directly.
 */
import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const PREVIEW_HOST_SOURCE = `// Run as: <node> preview-host.mjs <cli bin.js> dev <target> …
// The server that starts a preview holds this process's input open and never writes to it.
// When that server ends, however it ends, the input closes, and so does the preview.
import { pathToFileURL } from 'node:url'
const end = () => process.exit(0)
process.stdin.on('end', end)
process.stdin.on('close', end)
process.stdin.on('error', end)
process.stdin.resume()
process.stdin.unref?.()
const cli = process.argv[2]
process.argv.splice(1, 1)
await import(pathToFileURL(cli).href)
`

/** Where the host lives under a server's data folder. */
export const previewHostPath = (dataDir: string): string =>
  join(dataDir, 'slideless', 'preview-host.mjs')

/**
 * Write the host under `dataDir` when it is absent or not this text (an
 * older release's), owner-only, through a rename so a preview starting in
 * the same moment never runs half a file. Answers its path.
 */
export function writePreviewHost(dataDir: string): string {
  const file = previewHostPath(dataDir)
  let current: string | null = null
  try {
    current = readFileSync(file, 'utf8')
  } catch {
    current = null
  }
  if (current === PREVIEW_HOST_SOURCE) return file
  mkdirSync(join(dataDir, 'slideless'), { recursive: true })
  const staging = `${file}.${randomBytes(6).toString('hex')}.tmp`
  writeFileSync(staging, PREVIEW_HOST_SOURCE, { mode: 0o600 })
  renameSync(staging, file)
  chmodSync(file, 0o600)
  return file
}
