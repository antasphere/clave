import { Effect, Layer } from 'effect'
import { expect, it, vi } from 'vitest'
import type { FilesDirsChanged } from '@clave/contract/files'
import type { ServerEvent } from '@clave/contract/events'
import { FilesPort } from './port'
import { FilesEventsLive } from './events'
import { ServerEvents } from '../events'

it('logs a failed publish, keeps forwarding later changes and releases its resources', async () => {
  let listener: ((event: FilesDirsChanged) => void) | undefined
  let first!: () => void
  let second!: () => void
  const firstAttempt = new Promise<void>((resolve) => {
    first = resolve
  })
  const secondAttempt = new Promise<void>((resolve) => {
    second = resolve
  })
  const off = vi.fn(() => {
    listener = undefined
  })
  const dispose = vi.fn()
  const events: ServerEvent[] = []
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const source = FilesPort.layer({
    ...FilesPort.none,
    dispose,
    onEvent: (cb) => {
      listener = cb
      return off
    }
  })
  const target = Layer.succeed(ServerEvents, {
    stream: 'test',
    subscribe: () => () => {},
    publish: (event) =>
      Effect.sync(() => {
        events.push(event)
        if (events.length === 1) {
          first()
          throw new Error('publish failed')
        }
        second()
        return { id: 'next', at: 1, seq: 1, event }
      })
  })
  const event: FilesDirsChanged = {
    _tag: 'files.dirs_changed',
    namespace: 'window',
    root: '/repo',
    dirs: ['.']
  }
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Layer.build(FilesEventsLive.pipe(Layer.provide(Layer.merge(source, target))))
          listener!(event)
          yield* Effect.promise(() => firstAttempt)
          expect(log).toHaveBeenCalledWith(
            '[clave-server] file event not published',
            expect.anything()
          )
          listener!({ ...event, dirs: ['src'] })
          yield* Effect.promise(() => secondAttempt)
          expect(events).toEqual([event, { ...event, dirs: ['src'] }])
        })
      )
    )
    expect(off).toHaveBeenCalledOnce()
    expect(dispose).toHaveBeenCalledOnce()
    expect(listener).toBeUndefined()
  } finally {
    log.mockRestore()
  }
})
