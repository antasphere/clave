import { describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { parsePiUsageLines, scanPiUsageFile } from './pi-usage'

describe('Pi usage parser', () => {
  it('counts assistant and summary usage with cache and cost fields', () => {
    const records = parsePiUsageLines([
      JSON.stringify({
        type: 'message',
        timestamp: '2026-08-27T10:00:00Z',
        message: {
          role: 'assistant',
          usage: {
            input: 10,
            output: 4,
            cacheRead: 20,
            cacheWrite: 2,
            totalTokens: 36,
            cost: { total: 0.12 }
          }
        }
      }),
      JSON.stringify({
        type: 'compaction',
        timestamp: '2026-08-27T11:00:00Z',
        usage: {
          input: 3,
          output: 2,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 5,
          cost: { total: 0.01 }
        }
      })
    ])
    expect(
      records.map(({ input, output, cacheRead, cacheWrite, totalTokens, cost }) => ({
        input,
        output,
        cacheRead,
        cacheWrite,
        totalTokens,
        cost
      }))
    ).toEqual([
      { input: 10, output: 4, cacheRead: 20, cacheWrite: 2, totalTokens: 36, cost: 0.12 },
      { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: 0.01 }
    ])
  })

  it('streams transcript usage without retaining oversized lines', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clave-pi-usage-'))
    try {
      const filePath = path.join(dir, 'session.jsonl')
      fs.writeFileSync(
        filePath,
        [
          JSON.stringify({
            type: 'message',
            timestamp: '2026-08-27T10:00:00Z',
            message: { role: 'assistant', usage: { input: 1, output: 2 } }
          }),
          `{"usage":"${'x'.repeat(1024 * 1024 + 32)}"}`,
          JSON.stringify({
            type: 'message',
            timestamp: '2026-08-27T11:00:00Z',
            message: { role: 'assistant', usage: { input: 3, output: 4 } }
          })
        ].join('\n')
      )

      expect(
        scanPiUsageFile(filePath).map(
          ({ input, output, cacheRead, cacheWrite, totalTokens, cost }) => ({
            input,
            output,
            cacheRead,
            cacheWrite,
            totalTokens,
            cost
          })
        )
      ).toEqual([
        { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: 0 },
        { input: 3, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 7, cost: 0 }
      ])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
