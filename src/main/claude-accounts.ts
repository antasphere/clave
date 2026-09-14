import { app, safeStorage } from 'electron'
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'

/**
 * The Claude accounts a session can run on, owned by the main process.
 *
 * An account is a label plus one of three credential stories, in the order the
 * spawn and the usage read try them:
 *
 *  - a pasted long-lived OAuth token (`claude setup-token`), injected into the
 *    session as `CLAUDE_CODE_OAUTH_TOKEN`. Claude Code takes it ahead of the
 *    machine's own login, so the session runs on that subscription while its
 *    settings, plugins and history stay the shared `~/.claude`;
 *  - a `CLAUDE_CONFIG_DIR` of its own (the pre-token shape, issue #22), where
 *    Claude's login flow keeps a file-based credential;
 *  - nothing at all: the built-in Default account, a passthrough to whatever the
 *    machine is signed into.
 *
 * The list (`claude-accounts.json`) is public and crosses IPC; the tokens live
 * apart in `claude-accounts-credentials.json`, encrypted by the OS through
 * `safeStorage` like the OpenClaw tokens in `location-manager.ts`, and NEVER
 * leave this process: the renderer sees `hasToken`, the spawn path reads the
 * value at the moment it builds the environment, and nothing else does.
 *
 * Before this manager the list lived in the renderer's preference file
 * (`claudeProfiles` in `clave-preferences.json`); the first load imports it
 * once, so an account added under the old shape is still there.
 */
export interface ClaudeAccount {
  id: string
  label: string
  /** Absolute `CLAUDE_CONFIG_DIR`, or '' for the shared `~/.claude`. */
  configDir: string
  /** Whether a pasted token is held for this account. */
  hasToken: boolean
}

export const DEFAULT_CLAUDE_ACCOUNT_ID = 'default'

const DEFAULT_ACCOUNT: ClaudeAccount = {
  id: DEFAULT_CLAUDE_ACCOUNT_ID,
  label: 'Default',
  configDir: '',
  hasToken: false
}

interface StoredAccount {
  id: string
  label: string
  configDir: string
}

interface AccountsFile {
  v: 1
  accounts: StoredAccount[]
}

interface CredentialsFile {
  [accountId: string]: { token: string; setAt: number }
}

/** What `claude setup-token` prints: an `sk-ant-oat01-…` token. The check is a
 *  shape check, not an authority: the usage read after a paste is what proves
 *  the token. Loose on purpose so a future prefix still pastes. */
export function isPlausibleOauthToken(value: string): boolean {
  return /^sk-ant-[A-Za-z0-9_-]{20,}$/.test(value.trim())
}

function isStoredAccount(value: unknown): value is StoredAccount {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    typeof v.id === 'string' &&
    v.id.length > 0 &&
    v.id !== DEFAULT_CLAUDE_ACCOUNT_ID &&
    typeof v.label === 'string' &&
    (v.configDir === undefined || typeof v.configDir === 'string')
  )
}

type ChangeListener = (accounts: ClaudeAccount[]) => void

class ClaudeAccountsManager {
  private accounts: StoredAccount[] | null = null
  private credentials: CredentialsFile | null = null
  private listeners = new Set<ChangeListener>()

  private accountsPath(): string {
    return path.join(app.getPath('userData'), 'claude-accounts.json')
  }

  private credentialsPath(): string {
    return path.join(app.getPath('userData'), 'claude-accounts-credentials.json')
  }

  // Lazy on purpose: `app.getPath` and `safeStorage` are only usable after
  // app-ready, and this module is imported at boot.
  private loadAccounts(): StoredAccount[] {
    if (this.accounts) return this.accounts
    let parsed: unknown = null
    try {
      parsed = JSON.parse(fs.readFileSync(this.accountsPath(), 'utf-8'))
    } catch {
      parsed = null
    }
    const file = parsed as Partial<AccountsFile> | null
    if (file && Array.isArray(file.accounts)) {
      this.accounts = file.accounts.filter(isStoredAccount).map((a) => ({
        id: a.id,
        label: a.label,
        configDir: a.configDir ?? ''
      }))
    } else {
      this.accounts = this.importLegacyProfiles()
      this.saveAccounts()
    }
    return this.accounts
  }

  /** One-time import of the renderer-era list (`claudeProfiles` in
   *  `clave-preferences.json`). The old key is left in place: an older build
   *  reading the same profile still finds its accounts. */
  private importLegacyProfiles(): StoredAccount[] {
    try {
      const raw = JSON.parse(
        fs.readFileSync(path.join(app.getPath('userData'), 'clave-preferences.json'), 'utf-8')
      ) as Record<string, unknown>
      const legacy = raw.claudeProfiles
      if (!Array.isArray(legacy)) return []
      return legacy.filter(isStoredAccount).map((a) => ({
        id: a.id,
        label: a.label,
        configDir: a.configDir ?? ''
      }))
    } catch {
      return []
    }
  }

  private saveAccounts(): void {
    const file: AccountsFile = { v: 1, accounts: this.accounts ?? [] }
    const target = this.accountsPath()
    const tmp = `${target}.tmp`
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, target)
  }

  private loadCredentials(): CredentialsFile {
    if (this.credentials) return this.credentials
    try {
      const parsed = JSON.parse(fs.readFileSync(this.credentialsPath(), 'utf-8'))
      this.credentials = parsed && typeof parsed === 'object' ? (parsed as CredentialsFile) : {}
    } catch {
      this.credentials = {}
    }
    return this.credentials
  }

  private saveCredentials(): void {
    const target = this.credentialsPath()
    const tmp = `${target}.tmp`
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify(this.credentials ?? {}, null, 2), { mode: 0o600 })
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

  /** Every account, the Default first. Never carries a token value. */
  list(): ClaudeAccount[] {
    const credentials = this.loadCredentials()
    return [
      DEFAULT_ACCOUNT,
      ...this.loadAccounts().map((a) => ({
        id: a.id,
        label: a.label,
        configDir: a.configDir,
        hasToken: typeof credentials[a.id]?.token === 'string'
      }))
    ]
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

  add(input: { label: string; configDir?: string }): ClaudeAccount {
    const accounts = this.loadAccounts()
    const account: StoredAccount = {
      id: randomUUID(),
      label: input.label.trim() || 'Account',
      configDir: (input.configDir ?? '').trim()
    }
    accounts.push(account)
    this.saveAccounts()
    this.emit()
    return { ...account, hasToken: false }
  }

  update(id: string, updates: { label?: string; configDir?: string }): ClaudeAccount | undefined {
    if (id === DEFAULT_CLAUDE_ACCOUNT_ID) return DEFAULT_ACCOUNT
    const account = this.loadAccounts().find((a) => a.id === id)
    if (!account) return undefined
    if (updates.label !== undefined) account.label = updates.label.trim() || account.label
    if (updates.configDir !== undefined) account.configDir = updates.configDir.trim()
    this.saveAccounts()
    this.emit()
    return this.get(id)
  }

  /** Removing an account forgets its token with it. */
  remove(id: string): boolean {
    if (id === DEFAULT_CLAUDE_ACCOUNT_ID) return false
    const accounts = this.loadAccounts()
    const index = accounts.findIndex((a) => a.id === id)
    if (index === -1) return false
    accounts.splice(index, 1)
    this.saveAccounts()
    const credentials = this.loadCredentials()
    if (credentials[id]) {
      delete credentials[id]
      this.saveCredentials()
    }
    this.emit()
    return true
  }

  /** Store a pasted token, encrypted by the OS. Throws when the shape is not a
   *  token or when the OS cannot encrypt (never falls back to plaintext). */
  setToken(id: string, token: string): void {
    const trimmed = token.trim()
    if (id === DEFAULT_CLAUDE_ACCOUNT_ID) {
      throw new Error('The Default account is the machine login; add an account for a token.')
    }
    if (!this.loadAccounts().some((a) => a.id === id)) throw new Error('Unknown Claude account')
    if (!isPlausibleOauthToken(trimmed)) {
      throw new Error('That does not look like a Claude Code token (expected sk-ant-…).')
    }
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('OS encryption is unavailable, so the token cannot be stored securely.')
    }
    const credentials = this.loadCredentials()
    credentials[id] = {
      token: safeStorage.encryptString(trimmed).toString('base64'),
      setAt: Date.now()
    }
    this.saveCredentials()
    this.emit()
  }

  clearToken(id: string): void {
    const credentials = this.loadCredentials()
    if (!credentials[id]) return
    delete credentials[id]
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
    try {
      return safeStorage.decryptString(Buffer.from(stored, 'base64'))
    } catch {
      return undefined
    }
  }
}

export const claudeAccountsManager = new ClaudeAccountsManager()
