// PRDCT-2528: an agent's clave_open_session with mode codex and dangerous true
// opens a Codex tab that never asks for approval. Proven on the PROCESS, not on
// a badge: a recorder stands in for the codex binary through a launch profile
// and writes the argv it was handed, so the check is that the spawned command
// carries --yolo, the way the launcher's own Cmd+Y already did. A control call
// without the flag proves the recorder is not trivially satisfied.
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  callMcp,
  until,
  userDataDir,
  fixturePath
} from './harness.mjs'

const DIR = userDataDir('open-session-codex-yolo')
const ROOT = fixturePath('open-session-codex-yolo-root')
const RECORDER = `${ROOT}/fake-codex.sh`
const RECORDED = `${ROOT}/fake-codex.argv`
const WS = {
  id: 'codex-yolo-ws',
  name: 'Codex YOLO',
  rootDir: ROOT,
  profileFile: null,
  createdAt: 1
}

const recordedArgv = () =>
  until(
    () =>
      existsSync(RECORDED) ? readFileSync(RECORDED, 'utf-8').split('\n').filter(Boolean) : null,
    { tries: 40, gapMs: 250 }
  ).catch(() => null)

export async function run(t) {
  rmSync(DIR, { recursive: true, force: true })
  mkdirSync(ROOT, { recursive: true })
  // The stand-in for codex: records its argv one token per line, then stays
  // alive like the CLI would.
  writeFileSync(
    RECORDER,
    [
      '#!/bin/sh',
      `: > ${RECORDED}`,
      `for a in "$@"; do echo "$a" >> ${RECORDED}; done`,
      'sleep 60',
      ''
    ].join('\n')
  )
  chmodSync(RECORDER, 0o755)
  rmSync(RECORDED, { force: true })
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT])
  const { app, win } = await launchApp(DIR)
  const errors = []
  win.on('pageerror', (e) => errors.push(e.message))
  try {
    await win.evaluate(async (recorder) => {
      await window.electronAPI.launchProfileUpsert({
        id: 'e2e-codex-recorder',
        name: 'Codex recorder',
        family: 'codex',
        command: [recorder],
        additionalArgs: []
      })
      await window.electronAPI.launchProfileSetGlobal('codex', 'e2e-codex-recorder')
    }, RECORDER)

    // The call an agent makes for a lane in YOLO mode.
    const opened = await callMcp(app, 'openSession', {
      cwd: ROOT,
      mode: 'codex',
      dangerous: true,
      name: 'yolo lane'
    })
    t.check(
      'clave_open_session opened a tab for mode codex',
      typeof opened?.sessionId === 'string',
      opened
    )
    const listed = await callMcp(app, 'list', {})
    const tab = listed.sessions.find((s) => s.id === opened?.sessionId)
    t.check('the tab is a codex tab, not a plain terminal', tab?.mode === 'codex', tab)
    const argv = await recordedArgv()
    t.check(
      'the codex process Clave spawned for the call carries --yolo',
      argv !== null && argv.includes('--yolo'),
      argv
    )

    // The control: the same call without the flag spawns codex without it.
    rmSync(RECORDED, { force: true })
    const plain = await callMcp(app, 'openSession', { cwd: ROOT, mode: 'codex', name: 'plain' })
    t.check(
      'a second codex tab opened without the flag',
      typeof plain?.sessionId === 'string',
      plain
    )
    const plainArgv = await recordedArgv()
    t.check(
      'without the flag the codex process is spawned without --yolo',
      plainArgv !== null && !plainArgv.includes('--yolo'),
      plainArgv
    )
    t.check('no renderer error during the two launches', errors.length === 0, errors)
  } finally {
    await app.close()
    rmSync(ROOT, { recursive: true, force: true })
  }
}
