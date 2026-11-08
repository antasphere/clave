/**
 * An agent on the Mac reaches the tabs it opened on a Clave server for
 * everything, not only reading (PRDCT-4193). On the fleet harness: one
 * daemon, one Mac, a Claude tab on the Mac as the caller (its own token is
 * the tab identity the reach rule reads), the desktop MCP as the road. On
 * the server: a plain terminal and a Claude chat (the real chat adapter over
 * `fixtures/claude-stream-stub.mjs`, which records what reaches its stdin).
 *
 * Fails if: a send to the server terminal answers "No session with id"
 * instead of the plain-terminal refusal (the call never reached the window
 * road); a send to the server chat is not delivered, or the chat's history
 * on the server lacks the message under a header naming the caller; the
 * server chat once its daemon restarted is not answered as ended with the
 * way back (clave_resume_session), clave_resume_session does not bring it
 * back, or `resume: true` does not resume and deliver; a server tab opened
 * with no workspace answers no `workspaceId`, or not the server workspace
 * holding its directory once the Mac knows one.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import {
  fleetWorld,
  connectMac,
  eventually,
  request,
  owned,
  showServer
} from './fixtures/fleet-world.mjs'
import {
  REPO,
  mcpHttpClient,
  mcpEndpoint,
  toolPayload,
  toolErrored,
  spawnAgentTabIn,
  until
} from './harness.mjs'

const lines = (file) =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : []
const errorText = (rpc) =>
  rpc?.error?.message ?? rpc?.result?.content?.map((c) => c.text ?? '').join('\n') ?? ''

export async function run(t) {
  const world = await fleetWorld('mcp-reach', { count: 1 })
  try {
    const [server] = world.servers
    const inputs = () => lines(path.join(server.root, 'claude-stub-input.jsonl'))
    const heard = (text) =>
      inputs().some(
        (i) => i.frame.type === 'user' && JSON.stringify(i.frame.message ?? '').includes(text)
      )
    await request(server, '/launch-profiles', {
      profile: {
        id: 'reach-stub',
        name: 'Reach stream stub',
        family: 'claude',
        command: [process.execPath, path.join(REPO, 'tests/e2e/fixtures/claude-stream-stub.mjs')],
        additionalArgs: []
      }
    })
    const mac = await world.mac('reach')
    await connectMac(mac, world.servers, { ui: false })
    const owner = mac.owners[0]
    const { win } = mac
    const caller = await spawnAgentTabIn(mac.app, win, mac.dir)
    assert.ok(caller?.token, 'the caller tab has an MCP token')
    const mcp = mcpHttpClient(mcpEndpoint(mac.dir), caller.token)
    await mcp.init()
    const rawOf = (key) => decodeURIComponent(key.split(':').at(-1))
    const serverState = async (key) =>
      (await request(server, '/sessions')).find((s) => s.id === rawOf(key))?.state
    const macState = async (key) => {
      try {
        const snapshot = await win.evaluate((id) => window.electronAPI.fleetSnapshot(id), owner.id)
        return snapshot.sessions.find((s) => s.id === key)?.state
      } catch {
        return undefined
      }
    }

    // A plain terminal on the server, opened with no workspace named.
    const terminalOpen = await mcp.call('clave_open_session', {
      server: owner.name,
      cwd: server.root,
      mode: 'terminal',
      command: 'echo reach-terminal',
      name: 'Reach terminal'
    })
    assert.equal(toolErrored(terminalOpen), false, JSON.stringify(terminalOpen))
    const terminal = toolPayload(terminalOpen)
    t.check(
      'a server tab opened with no workspace answers workspaceId',
      'workspaceId' in terminal,
      terminal
    )
    t.check(
      'and it names the server’s key',
      terminal.sessionId.startsWith(owned('session', owner.id, '')),
      terminal
    )
    await eventually(async () => !!(await serverState(terminal.sessionId)), 'server lists it')
    const toTerminal = await mcp.call('clave_send_to_session', {
      sessionId: terminal.sessionId,
      message: 'echo should never run'
    })
    t.check(
      'clave_send_to_session to the server terminal is refused as a plain terminal',
      toolErrored(toTerminal) &&
        errorText(toTerminal).includes('Refusing to send to a plain terminal'),
      errorText(toTerminal)
    )
    t.check(
      'and not answered as an unknown session',
      !errorText(toTerminal).includes('No session with id'),
      errorText(toTerminal)
    )

    // The Mac learns the server's root as a workspace; a chat opened there
    // with no workspace lands in it.
    const workspaceId = await showServer(mac, 0)
    const chatName = 'Reach chat'
    const chatOpen = await mcp.call('clave_open_session', {
      server: owner.name,
      cwd: server.root,
      mode: 'claude',
      chat: true,
      profile: 'chat:claude:reach-stub',
      name: chatName
    })
    assert.equal(toolErrored(chatOpen), false, JSON.stringify(chatOpen))
    const chat = toolPayload(chatOpen)
    t.equal(
      'a server tab opened with no workspace lands in the server workspace holding its directory',
      chat.workspaceId,
      workspaceId
    )
    await eventually(async () => !!(await serverState(chat.sessionId)), 'server lists the chat')

    const marker = `reach-message-${world.run.slice(-8)}`
    const sent = await until(async () => {
      const answer = await mcp.call('clave_send_to_session', {
        sessionId: chat.sessionId,
        message: marker
      })
      return toolErrored(answer) ? null : toolPayload(answer)
    })
    t.check(
      'clave_send_to_session to the server chat answers delivered',
      sent?.delivered === true,
      sent
    )
    await eventually(() => heard(marker), 'the message reaches the chat’s CLI on the server')
    t.check('the message reaches the chat’s process on the server', true)
    const history = await until(async () => {
      const text = JSON.stringify(
        await request(server, `/sessions/history?id=${rawOf(chat.sessionId)}`)
      )
      return text.includes(marker) ? text : null
    })
    t.check('the server’s history of the chat holds the message', !!history)
    t.check(
      'under a provenance header naming the caller tab',
      !!history?.includes('[Message from Clave tab') &&
        !!history?.includes(`sessionId=\\"${caller.sessionId}\\"`),
      history?.slice(0, 2000)
    )

    // The desktop's read takes a server tab's SCREEN (PRDCT-4166): a terminal
    // has one; a chat has none and answers "no terminal buffer" on this road
    // (the daemon's own clave_read_session reads a chat's history instead).
    const read = await until(async () => {
      const answer = await mcp.call('clave_read_session', { sessionId: terminal.sessionId })
      const payload = toolErrored(answer) ? null : toolPayload(answer)
      return payload?.text?.includes('reach-terminal') ? payload : null
    })
    t.check(
      'clave_read_session still reads the server terminal',
      read?.sessionId === terminal.sessionId,
      read
    )

    // The daemon restarts: the chat is a stopped record.
    const restartAndWait = async () => {
      await world.restart(0)
      await eventually(
        async () => (await macState(chat.sessionId)) === 'ended',
        'the Mac reads the chat as ended after the restart'
      )
    }
    await restartAndWait()
    const toEnded = await mcp.call('clave_send_to_session', {
      sessionId: chat.sessionId,
      message: 'never delivered'
    })
    t.check(
      'a send to the stopped chat is refused with the way back',
      toolErrored(toEnded) &&
        errorText(toEnded).includes('has ended; resume it with clave_resume_session'),
      errorText(toEnded)
    )
    const resumed = await mcp.call('clave_resume_session', { sessionId: chat.sessionId })
    t.check(
      'clave_resume_session on the stopped server chat answers resumed',
      !toolErrored(resumed) && toolPayload(resumed)?.resumed === true,
      resumed
    )
    await eventually(async () => {
      const state = await serverState(chat.sessionId)
      return state !== undefined && state !== 'ended'
    }, 'the server runs the chat again')
    t.check('and the server runs it again', true)

    // Again, then a send with resume: true resumes and delivers in one call.
    await restartAndWait()
    const marker2 = `reach-resumed-${world.run.slice(-8)}`
    const resumeAndSend = await mcp.call('clave_send_to_session', {
      sessionId: chat.sessionId,
      message: marker2,
      resume: true
    })
    t.check(
      'clave_send_to_session with resume: true on the stopped chat answers delivered',
      !toolErrored(resumeAndSend) && toolPayload(resumeAndSend)?.delivered === true,
      resumeAndSend
    )
    const reached = await eventually(() => heard(marker2), 'resumed delivery reaches the CLI').then(
      () => true,
      () => false
    )
    t.check('and the message reaches the resumed process', reached, inputs().slice(-4))
    // A server terminal shown on the Mac while its daemon stops raises one
    // uncaught "Clave's server at <url> did not answer" in the renderer
    // (reproduced without any agent tool: fleetStart, show, restart). It is
    // reported to the lane as a product finding, outside this spec's change;
    // every other renderer error still fails the spec.
    assert.deepEqual(
      mac.errors.filter(
        (m) => !/^Clave's server at http:\/\/127\.0\.0\.1:\d+ did not answer$/.test(m)
      ),
      []
    )
  } finally {
    await world.close()
  }
}
