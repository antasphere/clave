// waitForBoot (PRDCT-1762) returns on the window's boot mark and on the
// discovery file of THIS launch: the app does not remove clave-server.json at
// quit, so a relaunch into the same folder finds the previous launch's file
// first (round 1 of the verifier). The page is a fake; the folder is real.
import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { waitForBoot } from './harness.mjs'

const page = (state) => ({ evaluate: async () => state })
const discovery = (dir, pid) =>
  writeFileSync(
    path.join(dir, 'clave-server.json'),
    JSON.stringify({ url: 'http://127.0.0.1:1', token: 't', mode: 'in-process', ok: true, pid })
  )

describe('waitForBoot', () => {
  it('returns on a complete boot once the discovery file carries this launch’s pid', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'clave-boot-'))
    try {
      discovery(dir, 4242)
      const out = await waitForBoot(page('complete'), { dir, pid: 4242, timeoutMs: 2000 })
      expect(out.state).toBe('complete')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('the restore prompt counts as a booted window a spec may drive', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'clave-boot-'))
    try {
      discovery(dir, 4242)
      expect(
        (await waitForBoot(page('restore-prompt'), { dir, pid: 4242, timeoutMs: 2000 })).state
      ).toBe('restore-prompt')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('a discovery file of another pid is stale, and the wait fails naming it', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'clave-boot-'))
    try {
      discovery(dir, 1)
      await expect(
        waitForBoot(page('complete'), { dir, pid: 4242, timeoutMs: 400 })
      ).rejects.toThrow(/clave-server.json stale/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('no mark within the timeout fails naming the mark', async () => {
    await expect(waitForBoot(page(null), { timeoutMs: 300 })).rejects.toThrow(/data-boot=unset/)
  })
  it('without a folder the server is not asked', async () => {
    expect((await waitForBoot(page('complete'), { timeoutMs: 300 })).state).toBe('complete')
  })
})
