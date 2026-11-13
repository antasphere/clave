import fs from 'fs'
import path from 'path'
import type { PiProviderEntry } from './provider-injection'
import { parsePiOwnDefault, type PiOwnDefault } from '../shared/pi-start-model'

/**
 * A Pi agent directory for one connection (PRDCT-4496), used as the tab's
 * `PI_CODING_AGENT_DIR`. Pi reads `models.json` from its agent directory
 * alone and puts auth.json before it, so the connection's directory holds a
 * symlink for every top-level entry of the person's own (sessions and
 * extensions stay shared) but no auth.json at all, one real `models.json`:
 * the person's providers with the connection's entry over them, its key a
 * variable name, and a COPY of `settings.json` (a real file, mode 0o600, the
 * person's content as it is, made again at every sync; absent when the person
 * has none). Pi writes its default provider and model into settings.json, so
 * a link would carry a choice made in a connection tab into the person's own
 * settings; the copy keeps it in the connection's directory, and the next
 * sync puts the person's settings back. The person's directory is only ever
 * read. The same shape as a Codex account's home (`syncCodexHome`).
 */

const MODELS_FILE = 'models.json'
const AUTH_FILE = 'auth.json'
const SETTINGS_FILE = 'settings.json'
const NOT_LINKED = new Set([MODELS_FILE, AUTH_FILE, SETTINGS_FILE])

type ModelsDoc = Record<string, unknown> & { providers: Record<string, unknown> }

function readModels(file: string): ModelsDoc {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const doc = parsed as Record<string, unknown>
      const providers =
        doc.providers && typeof doc.providers === 'object' && !Array.isArray(doc.providers)
          ? (doc.providers as Record<string, unknown>)
          : {}
      return { ...doc, providers: { ...providers } }
    }
  } catch {
    // Absent or unreadable: the connection's entry alone.
  }
  return { providers: {} }
}

/** The person's own Pi default model (`defaultProvider` / `defaultModel` of
 *  the `settings.json` in their agent directory), the one a Pi tab on a
 *  connection starts on when it belongs to the connection's provider
 *  (`piStartModel`). A settings file, never a credential: only those two
 *  fields are taken. Null when there is none or it cannot be read. */
export function readPiOwnDefault(homeAgentDir: string): PiOwnDefault | null {
  try {
    return parsePiOwnDefault(fs.readFileSync(path.join(homeAgentDir, SETTINGS_FILE), 'utf8'))
  } catch {
    return null
  }
}

function lstatOrNull(file: string): fs.Stats | null {
  try {
    return fs.lstatSync(file)
  } catch {
    return null
  }
}

export function syncPiConnectionDir(input: {
  root: string
  homeAgentDir: string
  connectionId: string
  providerId: string
  entry: Partial<PiProviderEntry> & { apiKey: string }
}): string {
  // The id names a directory: one path segment, never a way out of the root.
  if (
    !input.connectionId ||
    input.connectionId === '.' ||
    input.connectionId === '..' ||
    /[/\\]/.test(input.connectionId)
  )
    throw new Error('The connection id cannot name a directory.')
  const dir = path.join(input.root, input.connectionId)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })

  // No credential of Pi's own in this directory, whatever put one there (an
  // earlier link, or Pi itself, which writes an empty one at its start or a
  // login's): the connection's variable is the only key Pi finds.
  const auth = path.join(dir, AUTH_FILE)
  const authStat = lstatOrNull(auth)
  if (authStat) {
    if (authStat.isDirectory()) fs.rmSync(auth, { recursive: true, force: true })
    else fs.unlinkSync(auth)
  }

  let entries: string[] = []
  try {
    entries = fs.readdirSync(input.homeAgentDir)
  } catch {
    // Pi never ran here: models.json alone.
  }
  for (const name of entries) {
    if (NOT_LINKED.has(name)) continue
    const source = path.join(input.homeAgentDir, name)
    const target = path.join(dir, name)
    const stat = lstatOrNull(target)
    // A real file or directory is not ours to replace.
    if (stat && !stat.isSymbolicLink()) continue
    if (stat) {
      if (fs.readlinkSync(target) === source) continue
      fs.unlinkSync(target)
    }
    try {
      fs.symlinkSync(source, target)
    } catch {
      // Best effort: an entry Pi creates and deletes in between is not worth
      // failing a spawn over.
    }
  }

  // settings.json copied, never linked: what Pi saves in a connection tab
  // stays here. A link or a stale copy is replaced; none when the person has
  // none (a directory there is not ours and stays).
  const settings = path.join(dir, SETTINGS_FILE)
  const settingsStat = lstatOrNull(settings)
  if (!settingsStat?.isDirectory()) {
    let own: Buffer | null = null
    try {
      const source = path.join(input.homeAgentDir, SETTINGS_FILE)
      if (fs.statSync(source).isFile()) own = fs.readFileSync(source)
    } catch {
      // The person has no settings.json: the connection has none either.
    }
    if (settingsStat) fs.unlinkSync(settings)
    if (own) {
      fs.writeFileSync(settings, own, { mode: 0o600 })
      fs.chmodSync(settings, 0o600)
    }
  }

  const models = readModels(path.join(input.homeAgentDir, MODELS_FILE))
  const own = models.providers[input.providerId]
  models.providers[input.providerId] = {
    ...(own && typeof own === 'object' && !Array.isArray(own) ? own : {}),
    ...input.entry
  }
  const file = path.join(dir, MODELS_FILE)
  // A link left there would write through to the person's own file.
  if (lstatOrNull(file)?.isSymbolicLink()) fs.unlinkSync(file)
  fs.writeFileSync(file, JSON.stringify(models, null, 2) + '\n', { mode: 0o600 })
  fs.chmodSync(file, 0o600)
  return dir
}
