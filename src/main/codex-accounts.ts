import { app } from 'electron'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'

/**
 * The Codex accounts a session can run on, owned by the main process
 * (ADR 0002).
 *
 * Codex keeps its credential in `$CODEX_HOME/auth.json` and refreshes it in
 * place, so an account is a HOME: the Default account is the machine's own
 * `~/.codex`, untouched; every other account is a directory under Clave's
 * user data used as `CODEX_HOME` for the sessions that run on it. That
 * directory holds a real `auth.json` and a symlink for every other top-level
 * entry of the default home, so config, sessions, memories, skills and hooks
 * stay shared and `codex resume` works across accounts.
 *
 * The credential file is Codex's, not ours: this manager never reads it
 * beyond "is there one", never copies it, and protects it the way Codex
 * protects the default one — by directory permissions. `syncHome` runs at
 * every spawn: a new entry in `~/.codex` gets its link, a link whose target
 * is gone is dropped. A file Codex detached by rewriting it through a
 * temporary file stays detached until the next spawn re-links it; the edit
 * made through the detached copy is lost (accepted in the ADR).
 */
export interface CodexAccount {
  id: string
  label: string
  /** How the account signs in: a ChatGPT login through the browser, or an
   *  API key. An API-key account has no quota to read and is the pool's
   *  fallback only. */
  kind: 'chatgpt' | 'apiKey'
  /** Whether the account's home holds an `auth.json` yet. */
  hasCredential: boolean
}

export const DEFAULT_CODEX_ACCOUNT_ID = 'default'
export const CODEX_AUTH_FILE = 'auth.json'

interface StoredAccount {
  id: string
  label: string
  kind: 'chatgpt' | 'apiKey'
}

interface AccountsFile {
  v: 1
  accounts: StoredAccount[]
}

function isStoredAccount(value: unknown): value is StoredAccount {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    typeof v.id === 'string' &&
    v.id.length > 0 &&
    v.id !== DEFAULT_CODEX_ACCOUNT_ID &&
    typeof v.label === 'string' &&
    (v.kind === 'chatgpt' || v.kind === 'apiKey')
  )
}

/** Where the machine's own Codex lives: the user's `CODEX_HOME` when their
 *  login shell exports one, else `~/.codex`. */
export function defaultCodexHome(env: Record<string, string | undefined> = process.env): string {
  const fromEnv = env.CODEX_HOME?.trim()
  return fromEnv ? fromEnv : path.join(os.homedir(), '.codex')
}

/**
 * Bring an account's home up to date with the default home: a symlink for
 * every top-level entry but the credential, dangling links removed. Pure
 * over the filesystem, so a test can run it on two temp directories.
 *
 * Returns the names linked this time, for the log.
 */
export function syncCodexHome(home: string, defaultHome: string): string[] {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 })
  const linked: string[] = []
  let entries: string[] = []
  try {
    entries = fs.readdirSync(defaultHome)
  } catch {
    // No default home yet (Codex never ran): the account home stays a bare
    // directory Codex will populate on its own.
    return linked
  }
  const wanted = new Set(entries.filter((name) => name !== CODEX_AUTH_FILE))
  for (const name of fs.readdirSync(home)) {
    if (name === CODEX_AUTH_FILE) continue
    const target = path.join(home, name)
    let stat: fs.Stats
    try {
      stat = fs.lstatSync(target)
    } catch {
      continue
    }
    // Only links are ours to drop: a real file is either Codex's own rewrite
    // (kept, as the ADR accepts) or something the user put there.
    if (!stat.isSymbolicLink()) continue
    if (!wanted.has(name) || !fs.existsSync(target)) {
      try {
        fs.unlinkSync(target)
      } catch {
        // A link that cannot be removed is left; the next sync tries again.
      }
    }
  }
  for (const name of wanted) {
    const target = path.join(home, name)
    try {
      fs.lstatSync(target)
      continue
    } catch {
      // Absent: link it.
    }
    try {
      fs.symlinkSync(path.join(defaultHome, name), target)
      linked.push(name)
    } catch {
      // Best effort: a name Codex creates and deletes between the readdir
      // and the link is not worth failing a spawn over.
    }
  }
  return linked
}

type ChangeListener = (accounts: CodexAccount[]) => void

class CodexAccountsManager {
  private accounts: StoredAccount[] | null = null
  private listeners = new Set<ChangeListener>()

  private accountsPath(): string {
    return path.join(app.getPath('userData'), 'codex-accounts.json')
  }

  private homesRoot(): string {
    return path.join(app.getPath('userData'), 'codex-homes')
  }

  private loadAccounts(): StoredAccount[] {
    if (this.accounts) return this.accounts
    let parsed: unknown = null
    try {
      parsed = JSON.parse(fs.readFileSync(this.accountsPath(), 'utf-8'))
    } catch {
      parsed = null
    }
    const file = parsed as Partial<AccountsFile> | null
    this.accounts =
      file && Array.isArray(file.accounts)
        ? file.accounts
            .filter(isStoredAccount)
            .map((a) => ({ id: a.id, label: a.label, kind: a.kind }))
        : []
    return this.accounts
  }

  private saveAccounts(): void {
    const file: AccountsFile = { v: 1, accounts: this.accounts ?? [] }
    const target = this.accountsPath()
    const tmp = `${target}.tmp`
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, target)
  }

  private emit(): void {
    const list = this.list()
    for (const listener of this.listeners) listener(list)
  }

  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** The account's `CODEX_HOME`, or undefined for the Default (the machine's
   *  own home, whatever the user's shell says it is). */
  homeFor(id: string | undefined): string | undefined {
    if (!id || id === DEFAULT_CODEX_ACCOUNT_ID) return undefined
    if (!this.loadAccounts().some((a) => a.id === id)) return undefined
    return path.join(this.homesRoot(), id)
  }

  /** Whether the account's home holds a credential. The Default reads the
   *  machine's own home. */
  hasCredential(id: string, env?: Record<string, string | undefined>): boolean {
    const home = id === DEFAULT_CODEX_ACCOUNT_ID ? defaultCodexHome(env) : this.homeFor(id)
    if (!home) return false
    try {
      return fs.statSync(path.join(home, CODEX_AUTH_FILE)).isFile()
    } catch {
      return false
    }
  }

  /** Make the account's home current with the default one and return it —
   *  the call every spawn and every login makes. Undefined for the Default. */
  syncHome(id: string | undefined, env?: Record<string, string | undefined>): string | undefined {
    const home = this.homeFor(id)
    if (!home) return undefined
    const linked = syncCodexHome(home, defaultCodexHome(env))
    if (linked.length > 0) console.log(`[codex-accounts] linked ${linked.join(', ')} into ${id}`)
    return home
  }

  private publicAccount(stored: StoredAccount): CodexAccount {
    return {
      id: stored.id,
      label: stored.label,
      kind: stored.kind,
      hasCredential: this.hasCredential(stored.id)
    }
  }

  /** Every account, the Default first, the rest in the user's order. */
  list(env?: Record<string, string | undefined>): CodexAccount[] {
    return [
      {
        id: DEFAULT_CODEX_ACCOUNT_ID,
        label: 'Default',
        kind: 'chatgpt',
        hasCredential: this.hasCredential(DEFAULT_CODEX_ACCOUNT_ID, env)
      },
      ...this.loadAccounts().map((a) => this.publicAccount(a))
    ]
  }

  get(id: string | undefined): CodexAccount | undefined {
    if (!id) return undefined
    return this.list().find((a) => a.id === id)
  }

  /** Resolve an id or a label (case-insensitive); the id wins over a label. */
  resolve(ref: string): CodexAccount | undefined {
    const list = this.list()
    const byId = list.find((a) => a.id === ref)
    if (byId) return byId
    const exact = list.filter((a) => a.label === ref)
    if (exact.length === 1) return exact[0]
    const loose = list.filter((a) => a.label.toLowerCase() === ref.toLowerCase())
    return loose.length === 1 ? loose[0] : undefined
  }

  add(input: { label: string; kind: 'chatgpt' | 'apiKey' }): CodexAccount {
    const accounts = this.loadAccounts()
    const account: StoredAccount = {
      id: randomUUID(),
      label: input.label.trim() || 'Account',
      kind: input.kind === 'apiKey' ? 'apiKey' : 'chatgpt'
    }
    accounts.push(account)
    this.saveAccounts()
    this.emit()
    return this.publicAccount(account)
  }

  update(id: string, updates: { label?: string }): CodexAccount | undefined {
    if (id === DEFAULT_CODEX_ACCOUNT_ID) return this.get(id)
    const account = this.loadAccounts().find((a) => a.id === id)
    if (!account) return undefined
    if (updates.label !== undefined) account.label = updates.label.trim() || account.label
    this.saveAccounts()
    this.emit()
    return this.get(id)
  }

  /** The pool's order is the list's order (see the Claude manager). */
  reorder(ids: string[]): void {
    const accounts = this.loadAccounts()
    const byId = new Map(accounts.map((a) => [a.id, a]))
    const next: StoredAccount[] = []
    for (const id of ids) {
      const account = byId.get(id)
      if (account && !next.includes(account)) next.push(account)
    }
    for (const account of accounts) if (!next.includes(account)) next.push(account)
    this.accounts = next
    this.saveAccounts()
    this.emit()
  }

  /** Removing an account deletes its home — the credential with it. Only a
   *  directory under our own root is ever removed. */
  remove(id: string): boolean {
    if (id === DEFAULT_CODEX_ACCOUNT_ID) return false
    const accounts = this.loadAccounts()
    const index = accounts.findIndex((a) => a.id === id)
    if (index === -1) return false
    const home = this.homeFor(id)
    accounts.splice(index, 1)
    this.saveAccounts()
    if (home && path.dirname(home) === this.homesRoot()) {
      fs.rmSync(home, { recursive: true, force: true })
    }
    this.emit()
    return true
  }

  /** Forget the credential, keep the account: the next login writes a new
   *  one. The Default's file is the machine's and is never touched. */
  clearCredential(id: string): void {
    const home = this.homeFor(id)
    if (!home) return
    try {
      fs.rmSync(path.join(home, CODEX_AUTH_FILE), { force: true })
    } catch {
      // Nothing to forget.
    }
    this.emit()
  }

  /** Tell listeners the credential state may have moved (a login finished). */
  notifyChanged(): void {
    this.emit()
  }
}

export const codexAccountsManager = new CodexAccountsManager()
