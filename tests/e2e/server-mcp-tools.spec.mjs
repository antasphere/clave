/**
 * The daemon's own agent tools resolve tabs the way the desktop's do
 * (PRDCT-4192). No Mac: one daemon, a Claude chat on it as the caller (the
 * real chat adapter over `fixtures/claude-stream-stub.mjs`, which records
 * its argv and its stdin), and the caller's own `--mcp-config`, the file the
 * daemon writes under `<dataDir>/mcp-configs/` when the CLI starts, read for
 * the daemon MCP's url and the caller's bearer, exactly what the CLI gets.
 *
 * Fails if: a send to "mine" is typed into the caller instead of answered
 * as a checkpoint; clave_open_session answers no `workspaceId`; clave_list
 * loses the opener (`parentId`) of a tab once the daemon restarted (the
 * opener only in the listener's memory, before `openedBy` was on the
 * record); a send to a plain terminal is not refused; a send to a tab
 * nobody related opened is refused instead of delivered (the former reach
 * rule back, PRDCT-4236);
 * clave_resume_session does not restart a stopped tab.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { REPO, mcpHttpClient, toolErrored, toolPayload, until } from './harness.mjs'
import { fleetWorld, eventually, request } from './fixtures/fleet-world.mjs'

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
  const world = await fleetWorld('server-mcp', { count: 1 })
  try {
    const [server] = world.servers
    const processes = () => lines(path.join(server.root, 'claude-stub-processes.jsonl'))
    const inputs = () => lines(path.join(server.root, 'claude-stub-input.jsonl'))
    const userFrames = (pid) => inputs().filter((i) => i.pid === pid && i.frame.type === 'user')
    const state = async (id) => (await request(server, '/sessions')).find((s) => s.id === id)?.state

    await request(server, '/launch-profiles', {
      profile: {
        id: 'server-mcp-stub',
        name: 'Server MCP stream stub',
        family: 'claude',
        command: [process.execPath, path.join(REPO, 'tests/e2e/fixtures/claude-stream-stub.mjs')],
        additionalArgs: []
      }
    })
    const caller = await request(server, '/sessions/start', {
      cwd: server.root,
      options: { claudeMode: true, launchProfileId: 'chat:claude:server-mcp-stub' }
    })
    // The CLI starts at its first input; a first message starts it, and its
    // argv names the MCP config the daemon wrote for it.
    await request(server, '/sessions/type', { id: caller.id, text: 'caller first message' })
    await eventually(() => processes().length === 1, 'the caller CLI starts')
    const [launch] = processes()
    const configFile = launch.argv[launch.argv.indexOf('--mcp-config') + 1]
    t.check(
      'the caller CLI is launched with its config under the daemon’s mcp-configs',
      launch.argv.includes('--mcp-config') &&
        configFile === path.join(server.dataDir, 'mcp-configs', `${caller.id}.json`),
      launch.argv
    )
    const clave = JSON.parse(readFileSync(configFile, 'utf8')).mcpServers.clave
    t.equal('the config names the daemon’s MCP', clave.url, server.agentToolsUrl)
    // The CLI's own view of the tools: the url and the bearer of its config,
    // read again for each process (a process that ends takes its config away).
    const connect = async (file) => {
      const entry = JSON.parse(readFileSync(file, 'utf8')).mcpServers.clave
      const client = mcpHttpClient(entry.url, entry.headers.Authorization.replace(/^Bearer /, ''))
      await client.init()
      return client
    }
    let mcp = await connect(configFile)
    await eventually(() => userFrames(launch.pid).length === 1, 'the first message reached it')

    // "mine": a checkpoint, typed nowhere.
    const mine = await mcp.call('clave_send_to_session', {
      sessionId: 'mine',
      message: 'checkpoint-only note'
    })
    const checkpoint = toolPayload(mine)
    t.check(
      'clave_send_to_session to "mine" answers a checkpoint, not a delivery',
      !toolErrored(mine) && checkpoint?.checkpoint === true && checkpoint?.delivered === false,
      mine
    )

    // A terminal and a chat, opened by the caller.
    const terminalOpen = await mcp.call('clave_open_session', {
      cwd: server.root,
      mode: 'terminal',
      command: 'echo server-mcp-terminal',
      name: 'Server MCP terminal'
    })
    assert.equal(toolErrored(terminalOpen), false, JSON.stringify(terminalOpen))
    const terminal = toolPayload(terminalOpen)
    t.check(
      'clave_open_session on the daemon answers workspaceId',
      'workspaceId' in terminal,
      terminal
    )
    const chatOpen = await mcp.call('clave_open_session', {
      cwd: server.root,
      mode: 'claude',
      profile: 'chat:claude:server-mcp-stub',
      name: 'Server MCP chat'
    })
    assert.equal(toolErrored(chatOpen), false, JSON.stringify(chatOpen))
    const chat = toolPayload(chatOpen)
    const parents = async () => {
      const listed = toolPayload(await mcp.call('clave_list', {}))?.sessions ?? []
      return Object.fromEntries(listed.map((s) => [s.id, s.parentId ?? null]))
    }
    const before = await parents()
    t.check(
      'clave_list reports the caller as the parent of the tabs it opened',
      before[terminal.sessionId] === caller.id && before[chat.sessionId] === caller.id,
      before
    )

    const toTerminal = await mcp.call('clave_send_to_session', {
      sessionId: terminal.sessionId,
      message: 'echo never typed'
    })
    t.check(
      'clave_send_to_session to a plain terminal on the daemon is refused',
      toolErrored(toTerminal) &&
        errorText(toTerminal).includes('Refusing to send to a plain terminal'),
      errorText(toTerminal)
    )
    t.equal('and the checkpoint typed nothing into the caller', userFrames(launch.pid).length, 1)

    // The opened chat answers its opener as "parent" (its own config, read
    // once its process is up), and a tab nobody related opened is reached
    // all the same (PRDCT-4236: any tab of the server may be messaged).
    const chatConfig = path.join(server.dataDir, 'mcp-configs', `${chat.sessionId}.json`)
    await eventually(
      () => existsSync(chatConfig),
      'the opened chat’s CLI starts and gets its config'
    )
    const asChat = await connect(chatConfig)
    const toParent = await asChat.call('clave_send_to_session', {
      sessionId: 'parent',
      message: 'LANE DONE · from the opened chat'
    })
    t.check(
      'the opened chat reaches its opener as "parent"',
      !toolErrored(toParent) && toolPayload(toParent)?.sessionId === caller.id,
      toParent
    )
    await eventually(
      () =>
        userFrames(launch.pid).some((f) =>
          JSON.stringify(f).includes('LANE DONE · from the opened chat')
        ),
      'the parent’s CLI receives the message'
    )
    const stranger = await request(server, '/sessions/start', {
      cwd: server.root,
      options: { claudeMode: true, launchProfileId: 'chat:claude:server-mcp-stub' }
    })
    const toStranger = await mcp.call('clave_send_to_session', {
      sessionId: stranger.id,
      message: 'delivered to a stranger'
    })
    t.check(
      'a tab nobody related opened is messaged by the caller',
      !toolErrored(toStranger) && toolPayload(toStranger)?.delivered === true,
      toStranger
    )

    // The daemon restarts: every tab is a stopped record; the tokens are on disk.
    await world.restart(0)
    t.equal(
      'after the restart the opened chat is a stopped record',
      await state(chat.sessionId),
      'ended'
    )
    // The caller ended with its process, and its config with it: it is
    // resumed as the person would, and its new CLI reads the tools again.
    const ownLaunches = () =>
      processes().filter((p) => p.argv.includes(configFile) || p.argv.includes(caller.id))
    t.check('the caller’s config went with its ended process', !existsSync(configFile))
    await request(server, '/sessions/restart', { id: caller.id, account: {} })
    await eventually(async () => (await state(caller.id)) !== 'ended', 'the caller runs again')
    await request(server, '/sessions/type', { id: caller.id, text: 'caller after restart' })
    await eventually(() => ownLaunches().length === 2, 'the caller CLI starts again')
    const relaunch = ownLaunches()[1]
    const configAgain = relaunch.argv[relaunch.argv.indexOf('--mcp-config') + 1]
    t.equal('the resumed caller gets its config again', configAgain, configFile)
    mcp = await connect(configAgain)
    const after = await until(async () => {
      try {
        return await parents()
      } catch {
        return null
      }
    })
    t.check(
      'clave_list still reports the opener after the daemon restarted',
      after?.[terminal.sessionId] === caller.id && after?.[chat.sessionId] === caller.id,
      after
    )

    const resumed = await mcp.call('clave_resume_session', { sessionId: chat.sessionId })
    t.check(
      'clave_resume_session on the stopped chat answers resumed',
      !toolErrored(resumed) && toolPayload(resumed)?.resumed === true,
      resumed
    )
    await eventually(async () => {
      const s = await state(chat.sessionId)
      return s !== undefined && s !== 'ended'
    }, 'the daemon runs the chat again')
    t.check('and the daemon runs it again', true)
    // The chat's CLI exits on its own (a crash, /exit): the daemon holds the
    // chat in state ended, and a Resume brings it back (round 5, major 1).
    const chatConfigArg = path.join(server.dataDir, 'mcp-configs', `${chat.sessionId}.json`)
    const chatProcesses = () => processes().filter((p) => p.argv.includes(chatConfigArg))
    // The chat's processes so far include the one the daemon restart killed:
    // the live one is found by probing, newest first.
    const alive = (pid) => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    let victim
    await eventually(() => {
      victim = chatProcesses()
        .map((p) => p.pid)
        .reverse()
        .find(alive)
      return !!victim
    }, 'the resumed chat’s CLI runs')
    const launchesBefore = processes().length
    process.kill(victim, 'SIGTERM')
    await eventually(
      async () => (await state(chat.sessionId)) === 'ended',
      'the daemon holds the chat as ended once its CLI exited'
    )
    const resumedAgain = await mcp.call('clave_resume_session', { sessionId: chat.sessionId })
    t.check(
      'a chat whose CLI exited by itself is resumed by clave_resume_session',
      !toolErrored(resumedAgain) && toolPayload(resumedAgain)?.resumed === true,
      resumedAgain
    )
    await eventually(async () => {
      const s = await state(chat.sessionId)
      return s !== undefined && s !== 'ended'
    }, 'the daemon runs the chat again after its own exit')
    await eventually(() => processes().length > launchesBefore, 'a new CLI was launched for it')
    t.check('and the daemon runs it again', true)

    t.equal(
      'the caller’s first process was never typed the checkpoint',
      userFrames(launch.pid).filter((f) => JSON.stringify(f).includes('checkpoint-only note'))
        .length,
      0
    )
  } finally {
    await world.close()
  }
}
