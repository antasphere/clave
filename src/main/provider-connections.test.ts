import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'

import {
  PROVIDER_CONNECTIONS_CREDENTIALS_FILE,
  PROVIDER_CONNECTIONS_FILE,
  ProviderConnectionsManager,
  type ProviderConnection
} from './provider-connections'
import { eachTestPorts, standaloneTestPorts } from './ports/testing'

const KEY = 'sk-test-provider-0123456789abcdefghijklmnopqrstuvwxyz'
const OTHER_KEY = 'sk-test-provider-zyxwvutsrqponmlkjihgfedcba9876543210'

describe.each(eachTestPorts())('on %s', (_name, makePorts) => {
  const ports = makePorts()
  const manager = new ProviderConnectionsManager(ports)
  const standalone = _name === 'the standalone adapters'
  const security = (): ReturnType<typeof standaloneTestPorts>['security'] =>
    (ports as ReturnType<typeof standaloneTestPorts>).security
  const credentialsPath = (): string => path.join(ports.dir, PROVIDER_CONNECTIONS_CREDENTIALS_FILE)
  const listPath = (): string => path.join(ports.dir, PROVIDER_CONNECTIONS_FILE)

  beforeEach(async () => {
    for (const connection of manager.list()) await manager.remove(connection.id)
  })

  describe('the connection list', () => {
    it('adds a company card with its catalogue endpoints and numbers the next one', () => {
      const first = manager.add({ company: 'moonshot' })
      expect(first).toMatchObject({
        label: 'Moonshot',
        company: 'moonshot',
        kind: 'key',
        pool: 'moonshot',
        needsKey: true,
        hasKey: false,
        keySetAt: null
      })
      expect(first.endpoints).toEqual([
        { wireFormat: 'openai-chat', baseUrl: 'https://api.kimi.ai/coding/v1' },
        { wireFormat: 'anthropic-messages', baseUrl: 'https://api.kimi.ai/coding/' }
      ])
      expect(manager.add({ company: 'moonshot' }).label).toBe('Moonshot 2')
    })

    it('takes the base URL and the wire format of a generic provider, and refuses without them', () => {
      const lab = manager.add({
        company: 'generic',
        baseUrl: 'https://llm.example.test/v1',
        wireFormat: 'openai-chat',
        label: 'Lab box'
      })
      expect(lab.label).toBe('Lab box')
      expect(lab.endpoints).toEqual([
        { wireFormat: 'openai-chat', baseUrl: 'https://llm.example.test/v1' }
      ])
      expect(() => manager.add({ company: 'generic', wireFormat: 'openai-chat' })).toThrow(
        /base URL/
      )
      expect(() =>
        manager.add({ company: 'generic', baseUrl: 'ftp://x', wireFormat: 'openai-chat' })
      ).toThrow(/http/)
    })

    it('runs Ollama at the default or a given URL, and refuses it a key', async () => {
      const local = manager.add({ company: 'ollama' })
      expect(local.needsKey).toBe(false)
      expect(local.endpoints).toEqual([
        { wireFormat: 'openai-chat', baseUrl: 'http://localhost:11434/v1' }
      ])
      const box = manager.add({ company: 'ollama', baseUrl: 'http://10.0.0.5:11434/v1' })
      expect(box.endpoints[0].baseUrl).toBe('http://10.0.0.5:11434/v1')
      await expect(manager.setKey(box.id, KEY)).rejects.toThrow(/takes no key/)
    })

    it('renames, and survives a reload from disk', () => {
      const work = manager.add({ company: 'zai' })
      expect(manager.rename(work.id, '  Z work ')?.label).toBe('Z work')
      expect(manager.rename('nope', 'x')).toBeUndefined()
      expect(new ProviderConnectionsManager(ports).get(work.id)?.label).toBe('Z work')
    })

    it('lists the connections that serve the wire formats given', () => {
      const moonshot = manager.add({ company: 'moonshot' })
      const mistral = manager.add({ company: 'mistral' })
      const all = manager
        .serving(['anthropic-messages', 'openai-chat', 'openai-responses'])
        .map((c) => c.id)
      expect(all).toContain(moonshot.id)
      expect(manager.serving([])).toEqual([])
      const anthropic = manager.serving(['anthropic-messages']).map((c) => c.id)
      expect(anthropic).toContain(moonshot.id)
      expect(anthropic).not.toContain(mistral.id)
    })

    // ── Lane B (harness wave): provider connections ──
    it('lists the connections that serve a harness, through the wire formats its row speaks', () => {
      const moonshot = manager.add({ company: 'moonshot' })
      expect(manager.forHarness('pi').map((c) => c.id)).toContain(moonshot.id)
      expect(manager.forHarness('opencode').map((c) => c.id)).toContain(moonshot.id)
      expect(manager.forHarness('claude')).toEqual([])
      expect(manager.forHarness('antigravity')).toEqual([])
      expect(manager.forHarness('nope')).toEqual([])
    })

    it('tells its listeners the whole list on every change, until they leave', async () => {
      const seen: ProviderConnection[][] = []
      const off = manager.onChange((list) => seen.push(list))
      const work = manager.add({ company: 'deepseek' })
      expect(seen.at(-1)?.map((c) => c.id)).toEqual([work.id])
      manager.rename(work.id, 'Deep')
      expect(seen.at(-1)?.[0].label).toBe('Deep')
      await manager.setKey(work.id, KEY)
      expect(seen.at(-1)?.[0].hasKey).toBe(true)
      await manager.remove(work.id)
      expect(seen.at(-1)).toEqual([])
      expect(seen).toHaveLength(4)
      off()
      manager.add({ company: 'deepseek' })
      expect(seen).toHaveLength(4)
    })
  })

  describe('the keys', () => {
    // The files' mode is applied at creation and masked by the umask: under a
    // umask of 077 a file written 0o644 would still read 0o600. Forced to 022
    // here, so the mode checks below go red on any mode wider than 0o600.
    let previousUmask = 0
    beforeEach(() => {
      previousUmask = process.umask(0o022)
    })
    afterEach(() => {
      process.umask(previousUmask)
    })

    it('stores a key sealed, reports it, and hands it back only in main', async () => {
      const work = manager.add({ company: 'moonshot' })
      const view = await manager.setKey(work.id, `  ${KEY}\n`)
      expect(view.hasKey).toBe(true)
      expect(manager.hasKey(work.id)).toBe(true)
      expect(typeof manager.get(work.id)?.keySetAt).toBe('number')
      expect(await manager.openKey(work.id)).toBe(KEY)
      expect(fs.readFileSync(credentialsPath(), 'utf-8')).not.toContain(KEY)
      expect(fs.readFileSync(listPath(), 'utf-8')).not.toContain(KEY)
      expect(JSON.stringify(manager.list())).not.toContain(KEY)
      if (process.platform !== 'win32') {
        expect(fs.statSync(credentialsPath()).mode & 0o777).toBe(0o600)
        expect(fs.statSync(listPath()).mode & 0o777).toBe(0o600)
      }
    })

    it('the file holds what the port handed back, never the value', async () => {
      const work = manager.add({ company: 'moonshot' })
      await manager.setKey(work.id, KEY)
      const stored = JSON.parse(fs.readFileSync(credentialsPath(), 'utf-8'))[work.id].apiKey
      expect(typeof stored).toBe('string')
      if (standalone) {
        expect(stored.startsWith('keychain:')).toBe(true)
      } else {
        expect(stored).toBe(Buffer.from(`enc:${KEY}`).toString('base64'))
      }
    })

    it.runIf(standalone)(
      'replacing or removing a key forgets the old one in the secret store',
      async () => {
        const items = security().items
        expect(items.size).toBe(0)
        const work = manager.add({ company: 'moonshot' })
        await manager.setKey(work.id, KEY)
        expect(items.size).toBe(1)
        await manager.setKey(work.id, OTHER_KEY)
        expect([...items.values()]).toEqual([OTHER_KEY])
        await manager.remove(work.id)
        expect(items.size).toBe(0)
      }
    )

    it('forgets the key with the connection', async () => {
      const work = manager.add({ company: 'moonshot' })
      await manager.setKey(work.id, KEY)
      expect(await manager.remove(work.id)).toBe(true)
      expect(manager.list().map((c) => c.id)).not.toContain(work.id)
      expect(await manager.openKey(work.id)).toBeUndefined()
      expect(manager.hasKey(work.id)).toBe(false)
      expect(await manager.remove('nope')).toBe(false)
    })

    it('a seal that fails leaves the working key in place', async () => {
      const work = manager.add({ company: 'moonshot' })
      await manager.setKey(work.id, KEY)
      const locked = new ProviderConnectionsManager({
        ...ports,
        secrets: {
          ...ports.secrets,
          seal: async () => {
            throw new Error('the keychain is locked')
          }
        }
      })
      await expect(locked.setKey(work.id, OTHER_KEY)).rejects.toThrow(/locked/)
      expect(await new ProviderConnectionsManager(ports).openKey(work.id)).toBe(KEY)
      if (standalone) expect([...security().items.values()]).toEqual([KEY])
    })

    it('a write that fails after the seal leaves the working key in place too', async () => {
      const work = manager.add({ company: 'moonshot' })
      await manager.setKey(work.id, KEY)
      const full = new ProviderConnectionsManager({
        ...ports,
        storage: {
          ...ports.storage,
          write: () => {
            throw new Error('no space left on device')
          }
        }
      })
      await expect(full.setKey(work.id, OTHER_KEY)).rejects.toThrow(/no space/)
      expect(await new ProviderConnectionsManager(ports).openKey(work.id)).toBe(KEY)
      expect(await full.openKey(work.id)).toBe(KEY)
      if (standalone) expect([...security().items.values()]).toEqual([KEY])
    })

    it('a remove that lands during a key save leaves no key behind', async () => {
      const work = manager.add({ company: 'moonshot' })
      let release: () => void = () => {}
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const gated = new ProviderConnectionsManager({
        ...ports,
        secrets: {
          available: () => ports.secrets.available(),
          open: (sealed) => ports.secrets.open(sealed),
          discard: (sealed) => ports.secrets.discard(sealed),
          seal: async (plain) => {
            await gate
            return ports.secrets.seal(plain)
          }
        }
      })
      const saving = gated.setKey(work.id, KEY)
      saving.catch(() => {})
      // Let the save run up to its seal before the remove lands. The remove
      // waits for the save (one connection's key operations run one after
      // the other), so it is started, the seal released, then both awaited.
      await new Promise((resolve) => setTimeout(resolve, 0))
      const removing = gated.remove(work.id)
      release()
      await saving
      expect(await removing).toBe(true)
      expect(gated.list()).toEqual([])
      expect(await gated.openKey(work.id)).toBeUndefined()
      expect(new ProviderConnectionsManager(ports).list()).toEqual([])
      const onDisk = JSON.parse(fs.readFileSync(credentialsPath(), 'utf-8'))
      expect(Object.keys(onDisk)).not.toContain(work.id)
      expect(fs.readFileSync(credentialsPath(), 'utf-8')).not.toContain(KEY)
      if (standalone) expect(security().items.size).toBe(0)
    })

    it('a replace that finishes while a remove waits forgets the new key too', async () => {
      const work = manager.add({ company: 'moonshot' })
      await manager.setKey(work.id, KEY)
      // Gates on both seal and discard, each released by hand.
      const sealGates: Array<() => void> = []
      const discardGates: Array<() => void> = []
      const sealedByTheSave: string[] = []
      const discarded: string[] = []
      const gated = new ProviderConnectionsManager({
        ...ports,
        secrets: {
          available: () => ports.secrets.available(),
          open: (sealed) => ports.secrets.open(sealed),
          seal: async (plain) => {
            await new Promise<void>((resolve) => sealGates.push(resolve))
            const sealed = await ports.secrets.seal(plain)
            sealedByTheSave.push(sealed)
            return sealed
          },
          discard: async (sealed) => {
            await new Promise<void>((resolve) => discardGates.push(resolve))
            discarded.push(sealed)
            return ports.secrets.discard(sealed)
          }
        }
      })
      const settledOrder: string[] = []
      let saveError: unknown = null
      const saving = gated.setKey(work.id, OTHER_KEY).then(
        () => settledOrder.push('save'),
        (error) => {
          saveError = error
          settledOrder.push('save')
        }
      )
      const removing = gated.remove(work.id).then((removed) => {
        settledOrder.push('remove')
        return removed
      })
      const settle = async (): Promise<void> => {
        for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0))
      }
      await settle()
      // The seal first, then the discards, until both operations settle.
      for (let round = 0; round < 10 && settledOrder.length < 2; round++) {
        for (const release of sealGates.splice(0)) release()
        await settle()
        for (const release of discardGates.splice(0)) release()
        await settle()
      }
      await saving
      expect(await removing).toBe(true)
      expect(settledOrder).toHaveLength(2)

      if (saveError === null) {
        // The save ran first: the remove saw its key and forgot it.
        expect(sealedByTheSave).toHaveLength(1)
        // Compared as a boolean, so a failure never prints a sealed value.
        expect(discarded.includes(sealedByTheSave[0])).toBe(true)
      } else {
        // The remove ran first: the save found no connection.
        expect(String(saveError)).toMatch(/No such connection|Unknown provider connection/)
      }
      expect(gated.list()).toEqual([])
      expect(new ProviderConnectionsManager(ports).list()).toEqual([])
      const onDisk = JSON.parse(fs.readFileSync(credentialsPath(), 'utf-8'))
      expect(Object.keys(onDisk)).not.toContain(work.id)
      expect(await gated.openKey(work.id)).toBeUndefined()
      expect(await new ProviderConnectionsManager(ports).openKey(work.id)).toBeUndefined()
      if (standalone) expect(security().items.size).toBe(0)
    })

    it.runIf(standalone)(
      'a discard that fails leaves the connection and its key in place',
      async () => {
        const work = manager.add({ company: 'moonshot' })
        await manager.setKey(work.id, KEY)
        const locked = new ProviderConnectionsManager({
          ...ports,
          secrets: {
            ...ports.secrets,
            discard: async () => {
              throw new Error('the keychain is locked')
            }
          }
        })
        await expect(locked.remove(work.id)).rejects.toThrow(/locked/)
        expect(locked.list().map((c) => c.id)).toContain(work.id)
        expect(await locked.openKey(work.id)).toBe(KEY)
        const fresh = new ProviderConnectionsManager(ports)
        expect(fresh.list().map((c) => c.id)).toContain(work.id)
        expect(await fresh.openKey(work.id)).toBe(KEY)
        expect([...security().items.values()]).toEqual([KEY])
      }
    )

    it('never falls back to plaintext when the port cannot seal', async () => {
      const work = manager.add({ company: 'moonshot' })
      const locked = new ProviderConnectionsManager({
        ...ports,
        secrets: { ...ports.secrets, available: async () => false }
      })
      await expect(locked.setKey(work.id, KEY)).rejects.toThrow(/encryption/)
      expect(locked.hasKey(work.id)).toBe(false)
      expect(manager.hasKey(work.id)).toBe(false)
    })

    it('refuses an empty key and an unknown connection', async () => {
      const work = manager.add({ company: 'moonshot' })
      await expect(manager.setKey(work.id, '   ')).rejects.toThrow(/Paste the key first/)
      await expect(manager.setKey('nope', KEY)).rejects.toThrow(/Unknown/)
      expect(manager.hasKey(work.id)).toBe(false)
    })

    it.runIf(standalone)('refuses a key the Keychain cannot file, and stores nothing', async () => {
      const work = manager.add({ company: 'moonshot' })
      await expect(manager.setKey(work.id, `${KEY}é`)).rejects.toThrow(/ASCII/)
      expect(manager.hasKey(work.id)).toBe(false)
      expect(security().items.size).toBe(0)
    })

    it('a key sealed by the other adapter opens to nothing', async () => {
      const work = manager.add({ company: 'moonshot' })
      fs.writeFileSync(
        credentialsPath(),
        JSON.stringify({ [work.id]: { apiKey: 'not-this-adapters', setAt: 1 } })
      )
      const fresh = new ProviderConnectionsManager(ports)
      expect(fresh.hasKey(work.id)).toBe(true)
      expect(await fresh.openKey(work.id)).toBeUndefined()
      expect(JSON.stringify(fresh.list())).not.toContain('not-this-adapters')
      fs.writeFileSync(credentialsPath(), '{}')
    })
  })
})
