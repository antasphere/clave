import { describe, expect, it } from 'vitest'
import type { StoragePort } from './ports/storage'
import { USAGE_LEDGER_FILE, UsageLedger, parseLedger } from './usage-ledger'

function memoryStorage(): StoragePort & { docs: Map<string, string> } {
  const docs = new Map<string, string>()
  return {
    docs,
    pathOf: (name) => `/mem/${name}`,
    read: (name) => docs.get(name) ?? null,
    write: (name, text) => void docs.set(name, text),
    remove: (name) => void docs.delete(name),
    list: () => []
  }
}

describe('the ledger of starts (PRDCT-4551)', () => {
  it('appends one line per start, with the connection, its label and company, never a value', () => {
    const storage = memoryStorage()
    let now = 1000
    const ledger = new UsageLedger(
      () => storage,
      () => now
    )
    ledger.record({
      harness: 'pi',
      sessionId: 'pi-session-1',
      connectionId: 'c1',
      label: 'Kimi',
      company: 'moonshot'
    })
    now = 2000
    ledger.record({
      harness: 'opencode',
      sessionId: 'ses_made_up_1',
      connectionId: null,
      label: 'ignored'
    })
    const text = storage.docs.get(USAGE_LEDGER_FILE) ?? ''
    expect(
      text
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l))
    ).toEqual([
      {
        harness: 'pi',
        sessionId: 'pi-session-1',
        connectionId: 'c1',
        label: 'Kimi',
        company: 'moonshot',
        at: 1000
      },
      // On no connection, no label and no company.
      {
        harness: 'opencode',
        sessionId: 'ses_made_up_1',
        connectionId: null,
        label: null,
        company: null,
        at: 2000
      }
    ])
    expect(ledger.read()).toHaveLength(2)
  })

  it('writes a resume on another connection, and skips a start that changes nothing', () => {
    const storage = memoryStorage()
    const ledger = new UsageLedger(
      () => storage,
      () => 5
    )
    expect(
      ledger.record({
        harness: 'pi',
        sessionId: 's',
        connectionId: 'a',
        label: 'A',
        company: 'moonshot'
      })
    ).not.toBeNull()
    expect(
      ledger.record({
        harness: 'pi',
        sessionId: 's',
        connectionId: 'a',
        label: 'A',
        company: 'moonshot'
      })
    ).toBeNull()
    expect(
      ledger.record({
        harness: 'pi',
        sessionId: 's',
        connectionId: 'b',
        label: 'B',
        company: 'moonshot'
      })
    ).not.toBeNull()
    expect(ledger.record({ harness: 'pi', sessionId: 's', connectionId: null })).not.toBeNull()
    expect(ledger.read().map((l) => l.connectionId)).toEqual(['a', 'b', null])
  })

  it('refuses a session id that is not one, and never throws on a storage that fails', () => {
    const storage = memoryStorage()
    const ledger = new UsageLedger(() => storage)
    expect(ledger.record({ harness: 'pi', sessionId: '../escape' })).toBeNull()
    expect(ledger.record({ harness: 'pi', sessionId: undefined })).toBeNull()
    const broken = new UsageLedger(() => {
      throw new Error('disk')
    })
    expect(broken.record({ harness: 'pi', sessionId: 's' })).toBeNull()
    expect(broken.read()).toEqual([])
  })

  it('skips a torn line and keeps the rest', () => {
    expect(
      parseLedger(
        '{"harness":"pi","sessionId":"s","at":1}\n{"harness":"pi","sess\n{"harness":"x","sessionId":"s","at":1}\n'
      )
    ).toHaveLength(1)
  })
})
