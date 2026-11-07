/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS test helpers */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// The command against a fake server: a plain `node:http` listener that
// records every call and answers canned JSON, so what goes out (the route,
// the bearer, the body) and what comes back on stdout are both pinned. The
// secret must reach the request body and nothing else.

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'server-accounts.mjs')
const TOKEN = 'bearer-for-tests-0123456789abcdef0123456789'
const SECRET = 'sk-ant-oat01-SECRET-never-printed'

let server
let url
let dir
let calls = []
let answers = {}

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      calls.push({
        method: req.method,
        path: req.url,
        authorization: req.headers.authorization,
        body: body ? JSON.parse(body) : undefined
      })
      const [status, payload] = answers[`${req.method} ${req.url}`] ?? [404, { title: 'Not found' }]
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    })
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  url = `http://127.0.0.1:${server.address().port}`
  dir = mkdtempSync(path.join(os.tmpdir(), 'clave-server-accounts-test-'))
  writeFileSync(path.join(dir, 'clave-server.json'), JSON.stringify({ url, token: TOKEN }))
})

afterAll(async () => {
  await new Promise((done) => server.close(done))
  rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  calls = []
  answers = {}
})

function run(args, stdin = '', dataDir = dir) {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [SCRIPT, '--data-dir', dataDir, ...args],
      (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr })
    )
    child.stdin.end(stdin)
  })
}

const claudeAccount = (id, label, hasToken) => ({
  id,
  label,
  hasToken,
  tokenSetAt: null,
  tokenExpiresAt: null,
  tokenInvalid: false
})

describe('server-accounts', () => {
  it('lists the Claude accounts with the bearer, one line each', async () => {
    answers['GET /accounts/claude'] = [
      200,
      [claudeAccount('default', 'Default', false), claudeAccount('a1', 'Work', true)]
    ]
    const { code, stdout } = await run(['claude', 'list'])
    expect(code).toBe(0)
    expect(calls).toEqual([
      { method: 'GET', path: '/accounts/claude', authorization: `Bearer ${TOKEN}`, body: undefined }
    ])
    expect(stdout).toBe('default  Default  no\na1  Work  yes\n')
  })

  it('adds a Claude account and stores the token from stdin, never printing it', async () => {
    answers['POST /accounts/claude'] = [200, claudeAccount('a2', 'Team', false)]
    answers['POST /accounts/claude/token'] = [200, { windows: [], fetchedAt: 1 }]
    const { code, stdout, stderr } = await run(['claude', 'add', 'Team'], `  ${SECRET}\n`)
    expect(code).toBe(0)
    expect(calls.map((c) => [c.method, c.path, c.body])).toEqual([
      ['POST', '/accounts/claude', { label: 'Team' }],
      ['POST', '/accounts/claude/token', { id: 'a2', token: SECRET }]
    ])
    expect(calls.every((c) => c.authorization === `Bearer ${TOKEN}`)).toBe(true)
    expect(stdout).toContain('a2')
    expect(stdout + stderr).not.toContain(SECRET)
  })

  it('removes the account again when the server refuses its token, echoing nothing', async () => {
    answers['POST /accounts/claude'] = [200, { id: 'j1', label: 'Junk', hasToken: false }]
    answers['POST /accounts/claude/token'] = [
      422,
      { message: 'That does not look like a Claude Code token (expected sk-ant-…).' }
    ]
    answers['POST /accounts/claude/remove'] = [200, true]
    const result = await run(['claude', 'add', 'Junk'], 'not a token at all')
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('The server answered 422: That does not look like')
    expect(result.stderr).toContain('Nothing was added.')
    expect(calls.map((c) => [c.method, c.path, c.body])).toEqual([
      ['POST', '/accounts/claude', { label: 'Junk' }],
      ['POST', '/accounts/claude/token', { id: 'j1', token: 'not a token at all' }],
      ['POST', '/accounts/claude/remove', { id: 'j1' }]
    ])
    expect(result.stdout + result.stderr).not.toContain('not a token at all')
  })

  it('removes the Codex account again when the key is refused', async () => {
    answers['POST /accounts/codex'] = [200, { id: 'k1', label: 'Key', kind: 'apiKey' }]
    answers['POST /accounts/login/api-key'] = [
      200,
      { id: 'job', status: 'failed', message: 'codex login exited with status 1.' }
    ]
    answers['POST /accounts/codex/remove'] = [200, true]
    const result = await run(['codex', 'add-key', 'Key'], 'sk-REFUSED-KEY')
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('The key was refused: codex login exited with status 1.')
    expect(calls.map((c) => [c.method, c.path])).toEqual([
      ['POST', '/accounts/codex'],
      ['POST', '/accounts/login/api-key'],
      ['POST', '/accounts/codex/remove']
    ])
    expect(result.stdout + result.stderr).not.toContain('sk-REFUSED-KEY')
  })

  it('refuses an empty paste before creating anything', async () => {
    const { code, stderr } = await run(['claude', 'add', 'Team'], '\n')
    expect(code).toBe(1)
    expect(calls).toEqual([])
    expect(stderr).toContain('No token on stdin')
  })

  it('sets a token on an existing account', async () => {
    answers['POST /accounts/claude/token'] = [200, { windows: [], fetchedAt: 1 }]
    const { code, stdout } = await run(['claude', 'set-token', 'a1'], SECRET)
    expect(code).toBe(0)
    expect(calls[0].body).toEqual({ id: 'a1', token: SECRET })
    expect(stdout).not.toContain(SECRET)
  })

  it('adds a Codex API-key account and logs the key in', async () => {
    answers['POST /accounts/codex'] = [
      200,
      { id: 'c1', label: 'Keys', kind: 'apiKey', hasCredential: false }
    ]
    answers['POST /accounts/login/api-key'] = [200, { id: 'j1', status: 'done', message: null }]
    const { code, stdout, stderr } = await run(['codex', 'add-key', 'Keys'], SECRET)
    expect(code).toBe(0)
    expect(calls.map((c) => [c.method, c.path, c.body])).toEqual([
      ['POST', '/accounts/codex', { label: 'Keys', kind: 'apiKey' }],
      ['POST', '/accounts/login/api-key', { accountId: 'c1', apiKey: SECRET }]
    ])
    expect(stdout + stderr).not.toContain(SECRET)
  })

  it('lists the Codex accounts by credential', async () => {
    answers['GET /accounts/codex'] = [
      200,
      [{ id: 'c1', label: 'Keys', kind: 'apiKey', hasCredential: true }]
    ]
    const { stdout } = await run(['codex', 'list'])
    expect(stdout).toBe('c1  Keys  yes\n')
  })

  it("names the status and the problem's sentence on a refusal, not the body", async () => {
    answers['POST /accounts/claude/token'] = [
      400,
      { title: 'Refused', message: 'Unknown account', detail: 'internal detail' }
    ]
    const { code, stderr } = await run(['claude', 'set-token', 'nope'], SECRET)
    expect(code).toBe(1)
    expect(stderr).toContain('400: Unknown account')
    expect(stderr).not.toContain('internal detail')
    expect(stderr).not.toContain(SECRET)
  })

  it('says when the data folder holds no server', async () => {
    const empty = mkdtempSync(path.join(os.tmpdir(), 'clave-server-accounts-empty-'))
    try {
      const { code, stderr } = await run(['claude', 'list'], '', empty)
      expect(code).toBe(1)
      expect(stderr).toContain(`No Clave server data at ${empty}`)
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  it('prints the usage and exits 2 on a bad command', async () => {
    const { code, stderr } = await run(['claude', 'remove'])
    expect(code).toBe(2)
    expect(stderr).toContain('claude add <label>')
    const help = await run(['--help'])
    expect(help.stdout).toContain('codex add-key <label>')
  })
})
