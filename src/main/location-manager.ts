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
  private migrated = false

  constructor() {
    this.locationsPath = path.join(app.getPath('userData'), 'locations.json')
    this.credentialsPath = path.join(app.getPath('userData'), 'locations-credentials.json')
  }

  /** Public locations never carry the OpenClaw token — it lives encrypted in the credentials store. */
  getLocations(): Location[] {
    // Lazy migration: runs on first access (post app-ready, when safeStorage works),
    // never at module-eval time in the constructor.
    if (!this.migrated) {
      this.migrated = true
      this.migrateOpenclawTokens()
    }
    try {
      const raw = fs.readFileSync(this.locationsPath, 'utf-8')
      const locations = JSON.parse(raw) as Location[]
      const remote = locations.filter((l) => l.id !== 'local').map((l) => this.stripSecrets(l))
      return [LOCAL_LOCATION, ...remote]
    } catch {
      return [LOCAL_LOCATION]
    }
  }

  /** Decrypt and return the OpenClaw token for a location (main process only). */
  getOpenclawToken(id: string): string | undefined {
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

  private encryptSecret(value: string): string {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('OS encryption (safeStorage) is unavailable — cannot store secret securely')
    }
    return safeStorage.encryptString(value).toString('base64')
  }

  private decryptSecret(b64: string): string | undefined {
    try {
      return safeStorage.decryptString(Buffer.from(b64, 'base64'))
    } catch {
      return undefined
    }
  }

  /** One-time migration: move any plaintext openclawToken from locations.json into the encrypted store. */
  private migrateOpenclawTokens(): void {
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
            openclawToken: this.encryptSecret(loc.openclawToken as string)
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

  addLocation(loc: Omit<Location, 'id' | 'status'>, password?: string): Location {
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
      if (password) cred.password = this.encryptSecret(password)
      if (openclawToken) cred.openclawToken = this.encryptSecret(openclawToken)
      credentials[id] = cred
      this.saveCredentials(credentials)
    }

    return this.stripSecrets(newLocation)
  }

  updateLocation(id: string, updates: Partial<Location>): Location {
    if (id === 'local') {
      throw new Error('Cannot update the local location')
    }

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
        cred.openclawToken = this.encryptSecret(updates.openclawToken)
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

  getCredentials(id: string): SSHConnectionConfig | null {
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
        const decrypted = safeStorage.decryptString(Buffer.from(cred.password, 'base64'))
        config.password = decrypted
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
