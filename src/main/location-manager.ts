import * as fs from 'fs'
import * as path from 'path'
import { app, safeStorage } from 'electron'
import { randomUUID } from 'crypto'
import type { Location, LocationStatus, SSHConnectionConfig } from '../shared/remote-types'

interface EncryptedCredentials {
  password?: string // base64-encoded encrypted string
  openclawToken?: string // base64-encoded encrypted string
}

type CredentialsStore = Record<string, EncryptedCredentials>

const LOCAL_LOCATION: Location = {
  id: 'local',
  name: process.platform === 'darwin' ? 'This Mac' : 'This PC',
  type: 'local',
  status: 'connected'
}

class LocationManager {
  private locationsPath: string
  private credentialsPath: string
  /** The one-time move of plaintext tokens into the encrypted store, started
   *  on the first access (after app-ready, when `safeStorage` works) and
   *  awaited by every read of a secret, never by the plain listing. */
  private migration: Promise<void> | null = null

  constructor() {
    this.locationsPath = path.join(app.getPath('userData'), 'locations.json')
    this.credentialsPath = path.join(app.getPath('userData'), 'locations-credentials.json')
  }

  /** Public locations never carry the OpenClaw token — it lives encrypted in the credentials store. */
  getLocations(): Location[] {
    void this.ensureMigrated()
    try {
      const raw = fs.readFileSync(this.locationsPath, 'utf-8')
      const locations = JSON.parse(raw) as Location[]
      const remote = locations.filter((l) => l.id !== 'local').map((l) => this.stripSecrets(l))
      return [LOCAL_LOCATION, ...remote]
    } catch {
      return [LOCAL_LOCATION]
    }
  }

  private ensureMigrated(): Promise<void> {
    this.migration ??= this.migrateOpenclawTokens()
    return this.migration
  }

  /** Decrypt and return the OpenClaw token for a location (main process only). */
  async getOpenclawToken(id: string): Promise<string | undefined> {
    await this.ensureMigrated()
    const cred = this.loadCredentials()[id]
    if (!cred?.openclawToken) return undefined
    return this.decryptSecret(cred.openclawToken)
  }

  private stripSecrets(loc: Location): Location {
    if (loc.openclawToken === undefined) return loc
    const copy = { ...loc }
    delete copy.openclawToken
    return copy
  }

  private async encryptSecret(value: string): Promise<string> {
    if (!(await safeStorage.isAsyncEncryptionAvailable())) {
      throw new Error('OS encryption (safeStorage) is unavailable — cannot store secret securely')
    }
    return (await safeStorage.encryptStringAsync(value)).toString('base64')
  }

  private async decryptSecret(b64: string): Promise<string | undefined> {
    try {
      return (await safeStorage.decryptStringAsync(Buffer.from(b64, 'base64'))).result
    } catch {
      return undefined
    }
  }

  /** One-time migration: move any plaintext openclawToken from locations.json into the encrypted store. */
  private async migrateOpenclawTokens(): Promise<void> {
    let locations: Location[]
    try {
      locations = JSON.parse(fs.readFileSync(this.locationsPath, 'utf-8')) as Location[]
    } catch {
      return
    }
    const withTokens = locations.filter((l) => l.id !== 'local' && l.openclawToken)
    if (withTokens.length === 0) return

    try {
      const credentials = this.loadCredentials()
      for (const loc of withTokens) {
        try {
          credentials[loc.id] = {
            ...credentials[loc.id],
            openclawToken: await this.encryptSecret(loc.openclawToken as string)
          }
        } catch {
          // encryption unavailable — leave token in place rather than lose it
          return
        }
      }
      this.saveCredentials(credentials)
      this.saveLocations(locations.filter((l) => l.id !== 'local'))
    } catch {
      // best-effort migration; ignore failures
    }
  }

  async addLocation(loc: Omit<Location, 'id' | 'status'>, password?: string): Promise<Location> {
    await this.ensureMigrated()
    const locations = this.getLocations().filter((l) => l.id !== 'local')
    const id = randomUUID()
    const { openclawToken, ...rest } = loc
    const newLocation: Location = {
      ...rest,
      id,
      status: 'disconnected'
    }
    locations.push(newLocation)
    this.saveLocations(locations)

    if (password || openclawToken) {
      const credentials = this.loadCredentials()
      const cred: EncryptedCredentials = { ...credentials[id] }
      if (password) cred.password = await this.encryptSecret(password)
      if (openclawToken) cred.openclawToken = await this.encryptSecret(openclawToken)
      credentials[id] = cred
      this.saveCredentials(credentials)
    }

    return this.stripSecrets(newLocation)
  }

  async updateLocation(id: string, updates: Partial<Location>): Promise<Location> {
    if (id === 'local') {
      throw new Error('Cannot update the local location')
    }
    await this.ensureMigrated()

    const locations = this.getLocations().filter((l) => l.id !== 'local')
    const index = locations.findIndex((l) => l.id === id)
    if (index === -1) {
      throw new Error(`Location not found: ${id}`)
    }

    // The token, if present in the update, is encrypted into the credentials
    // store and never written to locations.json.
    if ('openclawToken' in updates) {
      const credentials = this.loadCredentials()
      const cred: EncryptedCredentials = { ...credentials[id] }
      if (updates.openclawToken) {
        cred.openclawToken = await this.encryptSecret(updates.openclawToken)
      } else {
        delete cred.openclawToken
      }
      credentials[id] = cred
      this.saveCredentials(credentials)
    }

    const safeUpdates = { ...updates }
    delete safeUpdates.openclawToken
    locations[index] = { ...locations[index], ...safeUpdates, id }
    this.saveLocations(locations)
    return this.stripSecrets(locations[index])
  }

  removeLocation(id: string): void {
    if (id === 'local') {
      throw new Error('Cannot remove the local location')
    }

    const locations = this.getLocations().filter((l) => l.id !== 'local')
    const filtered = locations.filter((l) => l.id !== id)
    this.saveLocations(filtered)

    const credentials = this.loadCredentials()
    delete credentials[id]
    this.saveCredentials(credentials)
  }

  async getCredentials(id: string): Promise<SSHConnectionConfig | null> {
    await this.ensureMigrated()
    const locations = this.getLocations()
    const location = locations.find((l) => l.id === id)
    if (!location || location.type === 'local') {
      return null
    }

    const credentials = this.loadCredentials()
    const cred = credentials[id]

    const config: SSHConnectionConfig = {
      host: location.host ?? '',
      port: location.port ?? 22,
      username: location.username ?? '',
      authMethod: location.authMethod ?? 'key'
    }

    if (cred?.password) {
      try {
        config.password = (
          await safeStorage.decryptStringAsync(Buffer.from(cred.password, 'base64'))
        ).result
      } catch {
        // Password decryption failed, return config without password
      }
    }

    return config
  }

  setLocationStatus(id: string, status: LocationStatus): void {
    if (id === 'local') return

    const locations = this.getLocations().filter((l) => l.id !== 'local')
    const index = locations.findIndex((l) => l.id === id)
    if (index === -1) return

    locations[index].status = status
    this.saveLocations(locations)
  }

  private saveLocations(locations: Location[]): void {
    // Defensive: never persist the OpenClaw token to the plaintext locations file.
    const sanitized = locations.map((l) => this.stripSecrets(l))
    fs.writeFileSync(this.locationsPath, JSON.stringify(sanitized, null, 2), 'utf-8')
  }

  private loadCredentials(): CredentialsStore {
    try {
      const raw = fs.readFileSync(this.credentialsPath, 'utf-8')
      return JSON.parse(raw) as CredentialsStore
    } catch {
      return {}
    }
  }

  private saveCredentials(credentials: CredentialsStore): void {
    fs.writeFileSync(this.credentialsPath, JSON.stringify(credentials, null, 2), 'utf-8')
  }
}

export const locationManager = new LocationManager()
