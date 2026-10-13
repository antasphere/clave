import { randomUUID } from 'crypto'
import { lazySettingsPorts, type SettingsPorts } from './ports/registry'
import { readJson, writeJson } from './ports/storage'

/**
 * The Claude accounts a session can run on, owned by the main process.
 *
 * An account is a label plus a pasted long-lived OAuth token (`claude
 * setup-token`), injected into the session as `CLAUDE_CODE_OAUTH_TOKEN`.
 * Claude Code takes it ahead of the machine's own login, so the session runs
 * on that subscription while its settings, plugins and history stay the
 * shared `~/.claude` — which is what lets a conversation be resumed on
 * another account (ADR 0002). The built-in Default account is a passthrough
 * to whatever the machine is signed into.
 *
 * The `CLAUDE_CONFIG_DIR` shape (issue #22) is retired: an account that
 * carried a directory keeps its label and is asked to sign in again. Its
 * history lived in that directory, so nothing on it could move between
 * accounts.
 *
 * The list (`claude-accounts.json`) is public and crosses IPC; the tokens live
 * apart in `claude-accounts-credentials.json` as the opaque strings the secret
 * port hands back (Electron's OS encryption in the app, the macOS Keychain for
 * the standalone server; `ports/secrets.ts`), and NEVER leave this process:
 * the renderer sees `hasToken`, the spawn path reads the value at the moment
 * it builds the environment, and nothing else does.
 *
 * Before this manager the list lived in the renderer's preference file
 * (`claudeProfiles` in `clave-preferences.json`); the first load imports it
 * once, so an account added under the old shape is still there.
 */
export interface ClaudeAccount {
  id: string
  label: string
  /** Whether a pasted token is held for this account. */
  hasToken: boolean
  /** When the token was captured, or null without one. */
  tokenSetAt: number | null
  /** When the token is assumed to stop working (the command prints no
   *  lifetime; a year is what a setup token has lasted), or null. */
  tokenExpiresAt: number | null
  /** The service refused the token on its last read: the account is out of
   *  the pool until a new token lands. */
  tokenInvalid: boolean
}

export const DEFAULT_CLAUDE_ACCOUNT_ID = 'default'
/** What a `claude setup-token` token is good for, as observed; the read that
 *  fails is the truth, this only drives the "expires in" line. */
export const CLAUDE_TOKEN_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000

const ACCOUNTS_FILE = 'claude-accounts.json'
const CREDENTIALS_FILE = 'claude-accounts-credentials.json'
const LEGACY_PREFERENCES_FILE = 'clave-preferences.json'

const DEFAULT_ACCOUNT: ClaudeAccount = {
  id: DEFAULT_CLAUDE_ACCOUNT_ID,
  label: 'Default',
  hasToken: false,
  tokenSetAt: null,
  tokenExpiresAt: null,
  tokenInvalid: false
}

interface StoredAccount {
  id: string
  label: string
}

interface AccountsFile {
  v: 1
  accounts: StoredAccount[]
}

interface StoredCredential {
  token: string
  setAt: number
  /** Set by the usage read that was refused; cleared by the next token. */
  invalidAt?: number
}

interface CredentialsFile {
  [accountId: string]: StoredCredential
}

/** What `claude setup-token` prints: an `sk-ant-oat01-…` token. The check is a
 *  shape check, not an authority: the usage read after a paste is what proves
 *  the token. Loose on purpose so a future prefix still pastes. */
export function isPlausibleOauthToken(value: string): boolean {
  return /^sk-ant-[A-Za-z0-9_-]{20,}$/.test(value.trim())
}

/** A stored account, from this file or the legacy renderer list. A
 *  `configDir` on it is the retired shape: the label survives, the directory
 *  does not (`migratedFromConfigDir` tells the caller which ones). */
function readStoredAccount(value: unknown): StoredAccount | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (typeof v.id !== 'string' || v.id.length === 0 || v.id === DEFAULT_CLAUDE_ACCOUNT_ID) {
    return null
  }
  if (typeof v.label !== 'string') return null
  return { id: v.id, label: v.label }
}

type ChangeListener = (accounts: ClaudeAccount[]) => void

export class ClaudeAccountsManager {
  private accounts: StoredAccount[] | null = null
  private credentials: CredentialsFile | null = null
  private listeners = new Set<ChangeListener>()
  /** Ids whose config-dir shape was dropped at this load: they need a login. */
  private migrated = new Set<string>()

  constructor(private readonly ports: SettingsPorts = lazySettingsPorts) {}

  // Lazy on purpose: the ports are resolved on first use, never at import, so
  // a `--user-data-dir` override set at boot is honoured.
  private loadAccounts(): StoredAccount[] {
    if (this.accounts) return this.accounts
    const parsed = readJson(this.ports.storage, ACCOUNTS_FILE)
    const file = parsed as Partial<AccountsFile> | null
    if (file && Array.isArray(file.accounts)) {
      this.accounts = this.importList(file.accounts)
      // The migration is written back once, so the retired field is gone
      // from disk and an older build reading the file sees no directory.
      if (this.migrated.size > 0) this.saveAccounts()
    } else {
      this.accounts = this.importList(this.legacyProfiles())
      this.saveAccounts()
    }
    return this.accounts
  }

  private importList(raw: unknown[]): StoredAccount[] {
    const out: StoredAccount[] = []
    for (const value of raw) {
      const account = readStoredAccount(value)
      if (!account) continue
      const dir = (value as Record<string, unknown>).configDir
      if (typeof dir === 'string' && dir.trim() !== '') this.migrated.add(account.id)
      out.push(account)
    }
    return out
  }

  /** One-time import of the renderer-era list (`claudeProfiles` in
   *  `clave-preferences.json`). The old key is left in place: an older build
   *  reading the same profile still finds its accounts. */
  private legacyProfiles(): unknown[] {
    const raw = readJson(this.ports.storage, LEGACY_PREFERENCES_FILE)
    const legacy = (raw as Record<string, unknown> | null)?.claudeProfiles
    return Array.isArray(legacy) ? legacy : []
  }

  private saveAccounts(): void {
    const file: AccountsFile = { v: 1, accounts: this.accounts ?? [] }
    writeJson(this.ports.storage, ACCOUNTS_FILE, file, { mode: 0o600 })
  }

  private loadCredentials(): CredentialsFile {
    if (this.credentials) return this.credentials
    const parsed = readJson(this.ports.storage, CREDENTIALS_FILE)
    this.credentials = parsed && typeof parsed === 'object' ? (parsed as CredentialsFile) : {}
    return this.credentials
  }

  private saveCredentials(): void {
    writeJson(this.ports.storage, CREDENTIALS_FILE, this.credentials ?? {}, { mode: 0o600 })
  }

  private emit(): void {
    const list = this.list()
    for (const listener of this.listeners) listener(list)
  }

  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private publicAccount(stored: StoredAccount): ClaudeAccount {
    const credential = this.loadCredentials()[stored.id]
    const hasToken = typeof credential?.token === 'string'
    const setAt = hasToken && typeof credential.setAt === 'number' ? credential.setAt : null
    return {
      id: stored.id,
      label: stored.label,
      hasToken,
      tokenSetAt: setAt,
      tokenExpiresAt: setAt === null ? null : setAt + CLAUDE_TOKEN_LIFETIME_MS,
      tokenInvalid: hasToken && typeof credential.invalidAt === 'number'
    }
  }

  /** Every account, the Default first, the rest in the user's order. Never
   *  carries a token value. */
  list(): ClaudeAccount[] {
    return [DEFAULT_ACCOUNT, ...this.loadAccounts().map((a) => this.publicAccount(a))]
  }

  /** The accounts whose config-dir shape was dropped at this load — they
   *  still exist, with their label, and need a token. */
  migratedAccountIds(): string[] {
    this.loadAccounts()
    return [...this.migrated]
  }

  get(id: string | undefined): ClaudeAccount | undefined {
    if (!id) return undefined
    return this.list().find((a) => a.id === id)
  }

  /** Resolve an id or a label (case-insensitive); the id wins over a label. */
  resolve(ref: string): ClaudeAccount | undefined {
    const list = this.list()
    const byId = list.find((a) => a.id === ref)
    if (byId) return byId
    const exact = list.filter((a) => a.label === ref)
    if (exact.length === 1) return exact[0]
    const loose = list.filter((a) => a.label.toLowerCase() === ref.toLowerCase())
    return loose.length === 1 ? loose[0] : undefined
  }

  add(input: { label: string }): ClaudeAccount {
    const accounts = this.loadAccounts()
    const account: StoredAccount = {
      id: randomUUID(),
      label: input.label.trim() || 'Account'
    }
    accounts.push(account)
    this.saveAccounts()
    this.emit()
    return this.publicAccount(account)
  }

  update(id: string, updates: { label?: string }): ClaudeAccount | undefined {
    if (id === DEFAULT_CLAUDE_ACCOUNT_ID) return DEFAULT_ACCOUNT
    const account = this.loadAccounts().find((a) => a.id === id)
    if (!account) return undefined
    if (updates.label !== undefined) account.label = updates.label.trim() || account.label
    this.saveAccounts()
    this.emit()
    return this.get(id)
  }

  /** The pool's order is the list's order: every non-default id, in the order
   *  given. Ids left out keep their place after the named ones; unknown ids
   *  are ignored. The Default is not reorderable and always first. */
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

  /** Removing an account forgets its token with it. */
  remove(id: string): boolean {
    if (id === DEFAULT_CLAUDE_ACCOUNT_ID) return false
    const accounts = this.loadAccounts()
    const index = accounts.findIndex((a) => a.id === id)
    if (index === -1) return false
    accounts.splice(index, 1)
    this.migrated.delete(id)
    this.saveAccounts()
    const credentials = this.loadCredentials()
    if (credentials[id]) {
      const sealed = credentials[id].token
      if (typeof sealed === 'string') this.ports.secrets.discard(sealed)
      delete credentials[id]
      this.saveCredentials()
    }
    this.emit()
    return true
  }

  /** Store a pasted or captured token, encrypted by the OS. Throws when the
   *  shape is not a token or when the OS cannot encrypt (never falls back to
   *  plaintext). A new token clears the refused mark and the migration mark. */
  setToken(id: string, token: string): void {
    const trimmed = token.trim()
    if (id === DEFAULT_CLAUDE_ACCOUNT_ID) {
      throw new Error('The Default account is the machine login; add an account for a token.')
    }
    if (!this.loadAccounts().some((a) => a.id === id)) throw new Error('Unknown Claude account')
    if (!isPlausibleOauthToken(trimmed)) {
      throw new Error('That does not look like a Claude Code token (expected sk-ant-…).')
    }
    if (!this.ports.secrets.available()) {
      throw new Error('OS encryption is unavailable here, so the token cannot be stored securely.')
    }
    const credentials = this.loadCredentials()
    // Seal first, forget the old one after: a seal that fails (a locked
    // keychain, a denied prompt) must leave the working token in place
    // rather than an account that says it holds one and opens to nothing.
    const sealed = this.ports.secrets.seal(trimmed)
    const previous = credentials[id]
    credentials[id] = { token: sealed, setAt: Date.now() }
    try {
      this.saveCredentials()
    } catch (error) {
      // The file still names the old value: the cache goes back to it, and
      // the item just sealed is forgotten rather than left orphaned.
      if (previous) credentials[id] = previous
      else delete credentials[id]
      this.ports.secrets.discard(sealed)
      throw error
    }
    this.migrated.delete(id)
    // An entry can lack a string token (a hand-edited or an older file):
    // there is nothing of it to forget, and the new token must still land.
    if (typeof previous?.token === 'string') this.ports.secrets.discard(previous.token)
    this.emit()
  }

  clearToken(id: string): void {
    const credentials = this.loadCredentials()
    if (!credentials[id]) return
    const sealed = credentials[id].token
    if (typeof sealed === 'string') this.ports.secrets.discard(sealed)
    delete credentials[id]
    this.saveCredentials()
    this.emit()
  }

  /** The service refused the token (a 401 on the read or the spawn): keep it,
   *  so the user sees which account died, but take it out of the pool. */
  markTokenInvalid(id: string): void {
    const credential = this.loadCredentials()[id]
    if (!credential || typeof credential.invalidAt === 'number') return
    credential.invalidAt = Date.now()
    this.saveCredentials()
    this.emit()
  }

  hasToken(id: string | undefined): boolean {
    if (!id) return false
    return typeof this.loadCredentials()[id]?.token === 'string'
  }

  /** The decrypted token. Main process only: the spawn environment and the
   *  usage read. Undefined when there is none or the OS refuses to decrypt. */
  getToken(id: string | undefined): string | undefined {
    if (!id) return undefined
    const stored = this.loadCredentials()[id]?.token
    if (typeof stored !== 'string') return undefined
    return this.ports.secrets.open(stored)
  }
}

export const claudeAccountsManager = new ClaudeAccountsManager()
