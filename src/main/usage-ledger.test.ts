import { describe, expect, it } from 'vitest'
import fs from 'fs'
import type { StoragePort } from './ports/storage'
import { installSettingsPorts, resetSettingsPorts } from './ports/registry'
import { electronTestPorts } from './ports/testing'
import type { LedgerLine } from './usage-attribution'
import { USAGE_LEDGER_FILE, UsageLedger, parseLedger, recordHarnessStart } from './usage-ledger'

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

  it('writes a move between two connections of one label and one company: the skip is on the connection', () => {
    const storage = memoryStorage()
    let now = 10
    const ledger = new UsageLedger(
      () => storage,
      () => now
    )
    const start = (connectionId: string): ReturnType<UsageLedger['record']> =>
      ledger.record({
        harness: 'pi',
        sessionId: 's',
        connectionId,
        label: 'Kimi',
        company: 'moonshot'
      })
    expect(start('c1')).not.toBeNull()
    now = 20
    expect(start('c2')).not.toBeNull()
    now = 30
    expect(start('c2')).toBeNull()
    expect(ledger.read().map((l) => [l.at, l.connectionId])).toEqual([
      [10, 'c1'],
      [20, 'c2']
    ])
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

  it("a change a tab's process reported is lined at the time it gave, never later than now (PRDCT-4551)", async () => {
    const ports = electronTestPorts()
    installSettingsPorts(ports)
    try {
      const ledger = new UsageLedger(() => ports.storage)
      // `recordHarnessStart` writes after an import of its own and answers
      // nothing to wait on: the document is read until it holds the line,
      // with a clear failure, not a short count of sleeps, when it never does.
      const lines = async (n: number): Promise<LedgerLine[]> => {
        const deadline = Date.now() + 20_000
        while (ledger.read().length < n) {
          if (Date.now() > deadline)
            throw new Error(
              `the ledger never held ${n} line(s) within 20 s: ${JSON.stringify(ledger.read())}`
            )
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        return ledger.read()
      }
      const before = Date.now()
      recordHarnessStart({ harness: 'pi', sessionId: 's', connectionId: 'c1', label: 'Kimi' })
      await lines(1)
      // The report's own time: the line is in force from it.
      recordHarnessStart({ harness: 'pi', sessionId: 's', connectionId: null, at: before + 1 })
      await lines(2)
      // A time ahead of this host's clock is taken as now.
      recordHarnessStart({
        harness: 'pi',
        sessionId: 's',
        connectionId: 'c1',
        label: 'Kimi',
        at: Date.now() + 3_600_000
      })
      const read = await lines(3)
      expect(read.map((l) => l.connectionId)).toEqual(['c1', null, 'c1'])
      expect(read[0].at).toBeGreaterThanOrEqual(before)
      expect(read[1].at).toBe(before + 1)
      expect(read[2].at).toBeLessThanOrEqual(Date.now())
    } finally {
      resetSettingsPorts()
      fs.rmSync(ports.dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('skips a torn line and keeps the rest', () => {
    expect(
      parseLedger(
        '{"harness":"pi","sessionId":"s","at":1}\n{"harness":"pi","sess\n{"harness":"x","sessionId":"s","at":1}\n'
      )
    ).toHaveLength(1)
  })
})
