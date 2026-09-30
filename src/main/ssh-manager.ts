import { Client, type ClientChannel, type SFTPWrapper } from 'ssh2'
import { readFileSync, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { join } from 'path'
import { app } from 'electron'
import type { SSHConnectionConfig } from '../shared/remote-types'

type SSHEventHandler = (locationId: string, error?: Error) => void

type KnownHostsStore = Record<string, string> // "host:port" → sha256 hex of host key

function knownHostsPath(): string {
  return join(app.getPath('userData'), 'ssh-known-hosts.json')
}

function loadKnownHosts(): KnownHostsStore {
  try {
    return JSON.parse(readFileSync(knownHostsPath(), 'utf-8')) as KnownHostsStore
  } catch {
    return {}
  }
}

function saveKnownHost(key: string, fingerprint: string): void {
  try {
    const store = loadKnownHosts()
    store[key] = fingerprint
    writeFileSync(knownHostsPath(), JSON.stringify(store, null, 2), 'utf-8')
  } catch {
    // best effort
  }
}

class SSHManager {
  private connections = new Map<string, Client>()
  private shells = new Map<string, ClientChannel>()
  private sftpCache = new Map<string, SFTPWrapper>()

  private onErrorHandlers: SSHEventHandler[] = []
  private onCloseHandlers: SSHEventHandler[] = []

  onError(handler: SSHEventHandler): void {
    this.onErrorHandlers.push(handler)
  }

  onClose(handler: SSHEventHandler): void {
    this.onCloseHandlers.push(handler)
  }

  connect(locationId: string, config: SSHConnectionConfig): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.connections.has(locationId)) {
        this.disconnect(locationId)
      }

      const client = new Client()

      client.on('ready', () => {
        this.connections.set(locationId, client)
        resolve()
      })

      client.on('error', (err) => {
        this.cleanup(locationId)
        for (const handler of this.onErrorHandlers) handler(locationId, err)
        reject(err)
      })

      client.on('close', () => {
        this.cleanup(locationId)
        for (const handler of this.onCloseHandlers) handler(locationId)
      })

      // Host-key pinning (trust-on-first-use). Without a hostVerifier, ssh2
      // accepts ANY host key, leaving the connection open to MITM (captured
      // password, hijacked session). We pin the key on first connect and abort
      // on any later mismatch.
      const knownHostKey = `${config.host}:${config.port}`
      const hostVerifier = (hashedKey: string, callback: (ok: boolean) => void): void => {
        const known = loadKnownHosts()[knownHostKey]
        if (!known) {
          saveKnownHost(knownHostKey, hashedKey)
          callback(true)
          return
        }
        if (known === hashedKey) {
          callback(true)
          return
        }
        console.error(
          `[ssh] host key mismatch for ${knownHostKey} — refusing connection (possible MITM). ` +
            `Remove it from ssh-known-hosts.json to re-trust after a legitimate key change.`
        )
        callback(false)
      }

      const connectOptions: Record<string, unknown> = {
        host: config.host,
        port: config.port,
        username: config.username,
        keepaliveInterval: 10000,
        keepaliveCountMax: 3,
        hostHash: 'sha256',
        hostVerifier
      }

      switch (config.authMethod) {
        case 'key':
          if (config.privateKeyPath) {
            connectOptions.privateKey = readFileSync(config.privateKeyPath)
          }
          break
        case 'password':
          connectOptions.password = config.password
          break
        case 'agent':
          connectOptions.agent = process.env.SSH_AUTH_SOCK
          break
      }

      client.connect(connectOptions)
    })
  }

  disconnect(locationId: string): void {
    const client = this.connections.get(locationId)
    if (client) {
      client.end()
      this.cleanup(locationId)
    }
  }

  isConnected(locationId: string): boolean {
    return this.connections.has(locationId)
  }

  exec(
    locationId: string,
    command: string
  ): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolve, reject) => {
      const client = this.connections.get(locationId)
      if (!client) {
        reject(new Error(`No connection for location: ${locationId}`))
        return
      }

      client.exec(command, (err, channel) => {
        if (err) {
          reject(err)
          return
        }

        let stdout = ''
        let stderr = ''

        channel.on('data', (data: Buffer) => {
          stdout += data.toString()
        })

        channel.stderr.on('data', (data: Buffer) => {
          stderr += data.toString()
        })

        channel.on('close', (code: number) => {
          resolve({ stdout, stderr, code: code ?? 0 })
        })
      })
    })
  }

  openShell(
    locationId: string,
    cwd?: string
  ): Promise<{ shellId: string; channel: ClientChannel }> {
    return new Promise((resolve, reject) => {
      const client = this.connections.get(locationId)
      if (!client) {
        reject(new Error(`No connection for location: ${locationId}`))
        return
      }

      client.shell((err, channel) => {
        if (err) {
          reject(err)
          return
        }

        const shellId = randomUUID()
        this.shells.set(shellId, channel)

        channel.on('close', () => {
          this.shells.delete(shellId)
        })

        if (cwd) {
          channel.write(`cd ${cwd}\n`)
        }

        resolve({ shellId, channel })
      })
    })
  }

  getShell(shellId: string): ClientChannel | undefined {
    return this.shells.get(shellId)
  }

  closeShell(shellId: string): void {
    const channel = this.shells.get(shellId)
    if (channel) {
      channel.close()
      this.shells.delete(shellId)
    }
  }

  getSftp(locationId: string): Promise<SFTPWrapper> {
    return new Promise((resolve, reject) => {
      const cached = this.sftpCache.get(locationId)
      if (cached) {
        resolve(cached)
        return
      }

      const client = this.connections.get(locationId)
      if (!client) {
        reject(new Error(`No connection for location: ${locationId}`))
        return
      }

      client.sftp((err, sftp) => {
        if (err) {
          reject(err)
          return
        }
        this.sftpCache.set(locationId, sftp)
        resolve(sftp)
      })
    })
  }

  disconnectAll(): void {
    for (const [locationId] of this.connections) {
      this.disconnect(locationId)
    }
  }

  private cleanup(locationId: string): void {
    this.connections.delete(locationId)
    this.sftpCache.delete(locationId)

    // Close any shells belonging to this connection
    for (const [shellId, channel] of this.shells) {
      // We can't directly map shell→location, so we close all shells
      // whose channel is already destroyed (connection gone)
      if (!channel.writable) {
        this.shells.delete(shellId)
      }
    }
  }
}

export const sshManager = new SSHManager()
