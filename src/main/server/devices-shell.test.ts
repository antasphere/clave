/**
 * The shell's devices port (PRDCT-4448): the shell's own Antasphere login as
 * the owner, read at the moment of every check and told at once of every
 * change, and the app's version on the phone's road.
 */
import { describe, expect, it, vi } from 'vitest'

const login = vi.hoisted(() => {
  let status: { phase: string; account: { subject: string } | null } = {
    phase: 'signed-in',
    account: { subject: 'owner-subject' }
  }
  const listeners = new Set<(status: unknown) => void>()
  return {
    manager: {
      status: () => status,
      onChange: (listener: (status: unknown) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    },
    set: (next: { phase: string; account: { subject: string } | null }) => {
      status = next
      for (const listener of [...listeners]) listener(next)
    },
    listeners
  }
})
vi.mock('../settings/shell-source', () => ({ shellAntasphereAccount: login.manager }))

import { shellDevicesPort } from './devices-shell'

describe('the shell’s devices port', () => {
  it('is the shell’s own login, told at once of its changes, with the app version on the road', () => {
    const port = shellDevicesPort('3.1.4')
    expect(port.road?.version).toBe('3.1.4')
    expect(port.ownerNow?.()).toBe('owner-subject')
    const told: Array<string | null> = []
    const off = port.onOwnerChanged!((owner) => told.push(owner))
    login.set({ phase: 'signed-out', account: null })
    expect(port.ownerNow?.()).toBeNull()
    expect(told).toEqual([null])
    off()
    expect(login.listeners.size).toBe(0)
  })
})
