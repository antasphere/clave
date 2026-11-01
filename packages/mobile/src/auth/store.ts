/**
 * What the sign-in keeps on the phone, in the secure store (expo-secure-store
 * through lane C's `SecureStorePort`, a Map in the tests): the client the
 * app registered at the hub (its id and the issuer it belongs to, nothing
 * secret, kept in the same store for one port rather than two), the person
 * (subject, name, email, when they signed in), and the three tokens. Each
 * token sits under its own key: expo-secure-store refuses a value past
 * 2 048 bytes, and an ID token with the profile claims is most of that on its
 * own. Nothing here is ever logged.
 */
import type { SecureStorePort } from '../machines/credentials'

export interface StoredClient {
  readonly issuer: string
  readonly clientId: string
  readonly registeredAt: number
}

export interface StoredAccount {
  readonly subject: string
  readonly name: string | null
  readonly email: string | null
  readonly emailVerified: boolean
}

export interface StoredSession {
  readonly issuer: string
  readonly clientId: string
  readonly account: StoredAccount
  readonly signedInAt: number
}

export interface StoredToken {
  readonly token: string
  /** Epoch milliseconds; the ID token's `exp`, the access token's `expires_in` from its arrival. */
  readonly expiresAt: number
}

export const STORE_KEYS = {
  client: 'clave.hub.client',
  session: 'clave.hub.session',
  refreshToken: 'clave.hub.refresh-token',
  accessToken: 'clave.hub.access-token',
  idToken: 'clave.hub.id-token'
} as const

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function readClient(value: unknown): StoredClient | null {
  if (!isRecord(value)) return null
  if (typeof value.issuer !== 'string' || typeof value.clientId !== 'string' || !value.clientId)
    return null
  return {
    issuer: value.issuer,
    clientId: value.clientId,
    registeredAt: typeof value.registeredAt === 'number' ? value.registeredAt : 0
  }
}

function readSession(value: unknown): StoredSession | null {
  if (!isRecord(value) || !isRecord(value.account)) return null
  if (typeof value.issuer !== 'string' || typeof value.clientId !== 'string') return null
  const account = value.account
  if (typeof account.subject !== 'string' || !account.subject) return null
  return {
    issuer: value.issuer,
    clientId: value.clientId,
    account: {
      subject: account.subject,
      name: typeof account.name === 'string' ? account.name : null,
      email: typeof account.email === 'string' ? account.email : null,
      emailVerified: account.emailVerified === true
    },
    signedInAt: typeof value.signedInAt === 'number' ? value.signedInAt : 0
  }
}

function readToken(value: unknown): StoredToken | null {
  if (!isRecord(value)) return null
  if (typeof value.token !== 'string' || !value.token) return null
  if (typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt)) return null
  return { token: value.token, expiresAt: value.expiresAt }
}

export class HubTokenStore {
  constructor(private readonly secure: SecureStorePort) {}

  private async readJson<T>(key: string, read: (value: unknown) => T | null): Promise<T | null> {
    const raw = await this.secure.getItemAsync(key)
    if (!raw) return null
    try {
      return read(JSON.parse(raw))
    } catch {
      return null
    }
  }

  readClient(): Promise<StoredClient | null> {
    return this.readJson(STORE_KEYS.client, readClient)
  }

  writeClient(client: StoredClient): Promise<void> {
    return this.secure.setItemAsync(STORE_KEYS.client, JSON.stringify(client))
  }

  clearClient(): Promise<void> {
    return this.secure.deleteItemAsync(STORE_KEYS.client)
  }

  readSession(): Promise<StoredSession | null> {
    return this.readJson(STORE_KEYS.session, readSession)
  }

  writeSession(session: StoredSession): Promise<void> {
    return this.secure.setItemAsync(STORE_KEYS.session, JSON.stringify(session))
  }

  async readRefreshToken(): Promise<string | null> {
    return (await this.secure.getItemAsync(STORE_KEYS.refreshToken)) || null
  }

  writeRefreshToken(token: string): Promise<void> {
    return this.secure.setItemAsync(STORE_KEYS.refreshToken, token)
  }

  readAccessToken(): Promise<StoredToken | null> {
    return this.readJson(STORE_KEYS.accessToken, readToken)
  }

  writeAccessToken(token: StoredToken): Promise<void> {
    return this.secure.setItemAsync(STORE_KEYS.accessToken, JSON.stringify(token))
  }

  readIdToken(): Promise<StoredToken | null> {
    return this.readJson(STORE_KEYS.idToken, readToken)
  }

  writeIdToken(token: StoredToken): Promise<void> {
    return this.secure.setItemAsync(STORE_KEYS.idToken, JSON.stringify(token))
  }

  /** The person and every token go; the client registration stays. */
  async clearSession(): Promise<void> {
    for (const key of [
      STORE_KEYS.session,
      STORE_KEYS.refreshToken,
      STORE_KEYS.accessToken,
      STORE_KEYS.idToken
    ])
      await this.secure.deleteItemAsync(key)
  }
}
