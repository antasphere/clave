import * as fs from 'node:fs'
import { join } from 'node:path'
import type { HistoryItem, SessionStream } from '../../shared/session-model'
import { privateDirectory, readPrivateFile } from '../ports/private-files'

interface SavedHistory {
  items: HistoryItem[]
  terminal: string
}
/** Bounded recent history, recorded independently of client subscriptions.
 *  Provider transcripts remain the full conversation source. Each checkpoint
 *  is atomic, at most 1 MiB, and includes at most 128 KiB of terminal output. */
export function serverHistory(dataDir: string): {
  record: (id: string, stream: SessionStream) => void
  read: (id: string) => SavedHistory
  remove: (id: string) => void
} {
  const directory = join(dataDir, 'server-history')
  privateDirectory(directory)
  const cache = new Map<string, SavedHistory>()
  const fileOf = (id: string): string => {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('Invalid history session id')
    return join(directory, `${id}.json`)
  }
  const read = (id: string): SavedHistory => {
    let value = cache.get(id)
    if (!value) {
      try {
        const parsed = JSON.parse(readPrivateFile(fileOf(id)).toString('utf8')) as SavedHistory
        if (!Array.isArray(parsed.items) || typeof parsed.terminal !== 'string')
          throw new Error('Invalid saved server history')
        value = parsed
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        value = { items: [], terminal: '' }
      }
      cache.set(id, value)
    }
    return value
  }
  return {
    read,
    record(id, stream) {
      if (
        stream.kind === 'event' &&
        ['provider_event', 'state_change', 'background_tasks'].includes(stream.event.type)
      )
        return
      const old = read(id)
      const next: SavedHistory =
        stream.kind === 'pty'
          ? {
              items: old.items,
              terminal: Buffer.concat([
                Buffer.from(old.terminal, 'base64'),
                Buffer.from(stream.data)
              ])
                .subarray(-128 * 1024)
                .toString('base64')
            }
          : {
              terminal: old.terminal,
              items: [...old.items, { event: stream.event, at: Date.now() }].slice(-2000)
            }
      while (Buffer.byteLength(JSON.stringify(next)) > 1024 * 1024 && next.items.length)
        next.items.shift()
      const file = fileOf(id)
      const tmp = `${file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(next), { mode: 0o600, flag: 'w' })
      fs.renameSync(tmp, file)
      cache.set(id, next)
    },
    remove(id) {
      cache.delete(id)
      fs.rmSync(fileOf(id), { force: true })
    }
  }
}
