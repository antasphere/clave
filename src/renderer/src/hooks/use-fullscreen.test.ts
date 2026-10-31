import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { EffectCallback } from 'react'
import { useFullScreen as fullscreenHook } from './use-fullscreen'

const hooks = vi.hoisted(() => ({
  value: false,
  effect: null as EffectCallback | null
}))

// Run the actual hook's effect and bridge callbacks with controlled ordering.
// The state/effect ports follow use-multi-repo-status.test.ts; no DOM is involved.
vi.mock('react', () => ({
  useState: (initial: boolean): [boolean, (value: boolean) => void] => {
    hooks.value = initial
    return [
      hooks.value,
      (value) => {
        hooks.value = value
      }
    ]
  },
  useEffect: (effect: EffectCallback): void => {
    hooks.effect = effect
  }
}))

beforeEach(() => {
  hooks.value = false
  hooks.effect = null
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function mount(): {
  resolveInitial: (value: boolean) => void
  initial: Promise<boolean>
  emit: (value: boolean) => void
  cleanup: () => void
  off: ReturnType<typeof vi.fn>
} {
  let resolveInitial!: (value: boolean) => void
  const initial = new Promise<boolean>((resolve) => {
    resolveInitial = resolve
  })
  let onChange!: (value: boolean) => void
  const off = vi.fn()
  vi.stubGlobal('window', {
    electronAPI: {
      windowIsFullScreen: () => initial,
      onWindowFullScreenChanged: (callback: (value: boolean) => void) => {
        onChange = callback
        return off
      }
    }
  })

  fullscreenHook()
  const cleanup = hooks.effect!()
  return {
    resolveInitial,
    initial,
    emit: (value) => onChange(value),
    cleanup: () => {
      if (typeof cleanup === 'function') cleanup()
    },
    off
  }
}

it.each([false, true])(
  'keeps a newer fullscreen event (%s) when the older initial query resolves later',
  async (event) => {
    const mounted = mount()
    try {
      mounted.emit(event)
      mounted.resolveInitial(!event)
      await mounted.initial
      expect(hooks.value).toBe(event)
    } finally {
      mounted.cleanup()
    }
    expect(mounted.off).toHaveBeenCalledOnce()
  }
)

it('uses the initial query when no event arrived and still accepts later events', async () => {
  const mounted = mount()
  try {
    mounted.resolveInitial(true)
    await mounted.initial
    expect(hooks.value).toBe(true)
    mounted.emit(false)
    expect(hooks.value).toBe(false)
  } finally {
    mounted.cleanup()
  }
})

it('ignores an initial query that resolves after unmount and unsubscribes', async () => {
  const mounted = mount()
  mounted.cleanup()
  mounted.resolveInitial(true)
  await mounted.initial
  expect(hooks.value).toBe(false)
  expect(mounted.off).toHaveBeenCalledOnce()
})
