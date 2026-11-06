/**
 * The run's deck (ADR 0004): the routine's template folder copied into the
 * run's own folder under the server's `routines/decks/`, `data.json`
 * written beside it and the template's `slideless-data` block filled with
 * the same content, an envelope around the agent's data. The decks root
 * carries an `index.html` naming the runs, so the Slideless viewer (one
 * `slideless dev` child over the root, the Analytics plugin's own viewer
 * module) serves every run's page on the loopback. Nothing leaves the Mac.
 *
 * A template is a folder the `.clave` names inside its own root; the copy
 * is bounded (`MAX_TEMPLATE_BYTES`), follows no symlink, and refuses a
 * template without an `index.html` carrying the data block.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { RoutineRun, RoutineStatus } from '@clave/contract/routines'
import { hashKey } from './claims'

export const DECKS_DIR = path.join('routines', 'decks')
export const DATA_BLOCK =
  /<script\s+type="application\/json"\s+id="slideless-data"\s*>[\s\S]*?<\/script>/i
export const MAX_TEMPLATE_BYTES = 5 * 1024 * 1024

/** What `data.json` and the page's data block carry: the run's envelope and the agent's data. */
export interface DeckEnvelope {
  routine: { key: string; name: string; schedule: string; file: string }
  run: {
    id: string
    trigger: RoutineRun['trigger']
    startedAt: number
    endedAt: number
    status: RoutineStatus
    headline: string
    summary: string
    reportedAt: number
    agent: RoutineRun['agent']
    model: string | null
    account: string | null
  }
  data: unknown
}

export type TemplateCheck = { ok: true; index: string } | { ok: false; reason: string }

/** Whether a folder is a usable template: inside `root`, a folder, with an
 *  `index.html` that carries the data block, under the size bound. */
export function checkTemplate(template: string, root: string): TemplateCheck {
  let stat: fs.Stats
  try {
    stat = fs.statSync(template)
  } catch {
    return { ok: false, reason: `the report template ${template} does not exist` }
  }
  if (!stat.isDirectory())
    return { ok: false, reason: `the report template ${template} is not a folder` }
  // Resolved through symlinks on both sides, so a link out of the folder is
  // still outside it.
  const real = (p: string): string => {
    try {
      return fs.realpathSync(p)
    } catch {
      return path.resolve(p)
    }
  }
  const rel = path.relative(real(root), real(template))
  if (rel.startsWith('..') || path.isAbsolute(rel))
    return {
      ok: false,
      reason: `the report template ${template} is outside the .clave file's folder`
    }
  const index = path.join(template, 'index.html')
  let html: string
  try {
    html = fs.readFileSync(index, 'utf8')
  } catch {
    return { ok: false, reason: `the report template has no index.html (${index})` }
  }
  if (!DATA_BLOCK.test(html))
    return {
      ok: false,
      reason: `the report template's index.html has no <script type="application/json" id="slideless-data"> block`
    }
  const size = folderSize(template, MAX_TEMPLATE_BYTES + 1)
  if (size > MAX_TEMPLATE_BYTES)
    return { ok: false, reason: `the report template is larger than 5 MiB` }
  return { ok: true, index }
}

function folderSize(dir: string, stopAt: number): number {
  let total = 0
  const walk = (d: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (total > stopAt) return
      const full = path.join(d, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) total += fs.statSync(full).size
    }
  }
  walk(dir)
  return total
}

/** Copy a folder, files and folders only, no symlink followed. */
function copyFolder(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true })
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name)
    const dst = path.join(to, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) copyFolder(src, dst)
    else if (entry.isFile()) fs.copyFileSync(src, dst)
  }
}

/** No `<` survives inside the block: a `</script>` would close it early and
 *  a `<!--<script` would put the HTML tokenizer in its double-escaped state
 *  (round 1, F4). `\u003c` is the same character to JSON. */
export const escapeForScript = (json: string): string => json.replace(/</g, '\\u003c')

export interface WrittenDeck {
  /** The run's folder on disk. */
  folder: string
  /** The page's path under the decks root, what the viewer serves: `<routine>/<run>/index.html`. */
  relative: string
}

/** Write the run's deck: the template copied, the data block filled, `data.json` beside. */
export function writeDeck(input: {
  decksRoot: string
  routineKey: string
  runId: string
  template: string
  envelope: DeckEnvelope
}): WrittenDeck {
  const routineFolder = hashKey(input.routineKey)
  const folder = path.join(input.decksRoot, routineFolder, input.runId)
  fs.rmSync(folder, { recursive: true, force: true })
  copyFolder(input.template, folder)
  const json = JSON.stringify(input.envelope, null, 2)
  fs.writeFileSync(path.join(folder, 'data.json'), json + '\n')
  const index = path.join(folder, 'index.html')
  const html = fs.readFileSync(index, 'utf8')
  const filled = html.replace(
    DATA_BLOCK,
    `<script type="application/json" id="slideless-data">\n${escapeForScript(json)}\n</script>`
  )
  fs.writeFileSync(index, filled)
  writeRootIndex(input.decksRoot)
  return { folder, relative: `${routineFolder}/${input.runId}/index.html` }
}

/** The root page the viewer serves at `/`: one link per run on disk. */
export function writeRootIndex(decksRoot: string): void {
  fs.mkdirSync(decksRoot, { recursive: true })
  const links: string[] = []
  for (const routine of safeReaddir(decksRoot)) {
    const folder = path.join(decksRoot, routine)
    if (!fs.statSync(folder).isDirectory()) continue
    for (const run of safeReaddir(folder)) {
      if (fs.existsSync(path.join(folder, run, 'index.html')))
        links.push(`<li><a href="./${routine}/${run}/index.html">${routine}/${run}</a></li>`)
    }
  }
  fs.writeFileSync(
    path.join(decksRoot, 'index.html'),
    `<!doctype html><html><head><meta charset="utf-8"><title>Clave · Routine decks</title></head><body><h1>Routine decks</h1><ul>${links.join('')}</ul></body></html>\n`
  )
}

const safeReaddir = (dir: string): string[] => {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}

/** Remove every deck of a routine (its history was forgotten). */
export function removeRoutineDecks(decksRoot: string, routineKey: string): void {
  fs.rmSync(path.join(decksRoot, hashKey(routineKey)), { recursive: true, force: true })
  writeRootIndex(decksRoot)
}
