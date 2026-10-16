// Run with the repository's Bun, which loads the installed framework's TS
// exports. Authentication arrives on stdin and is never part of the receipt.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Effect, Layer, Schema } from 'effect'
import { Command, CommandHandler, HandlerRegistry, layer as buses } from '@structure-ai/cqrs'
import { defineFixture, defineScenario, makeCatalog, run } from '@structure-ai/fixtures'
import { createApiClient } from '../../../packages/client/src/api.ts'

export const SCENARIO = 'personal-fleet/two-owners'
export const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const command = (call) =>
  Effect.tryPromise({ try: call, catch: () => new Error('Fleet fixture command failed') })

const SeedOwner = Command.define('SeedPersonalFleetOwner', {
  payload: Schema.Struct({
    index: Schema.Int,
    sessionId: Schema.String,
    groupId: Schema.String,
    directory: Schema.String,
    runId: Schema.String
  }),
  success: Schema.Struct({
    sessionId: Schema.String,
    groupId: Schema.String,
    directory: Schema.String,
    file: Schema.String,
    content: Schema.String,
    root: Schema.String
  })
})

export function personalFleetCatalog() {
  const identity = defineFixture({
    key: 'personal-fleet/identity',
    create: ({ id }) =>
      Effect.succeed({ sessionId: id('session'), groupId: id('group'), directory: id('directory') })
  })

  const owner = (index) =>
    defineFixture({
      key: `personal-fleet/owner-${index + 1}`,
      dependencies: { identity },
      create: ({ dispatch, dependencies, runId }) =>
        dispatch(SeedOwner, {
          index,
          ...dependencies.identity,
          runId
        })
    })
  return makeCatalog({
    base: { identity },
    scenarios: [
      defineScenario({
        name: SCENARIO,
        description:
          'Two personal standalone owners with colliding IDs, live history and editable owner content.',
        input: Schema.Struct({}),
        fixtures: () => ({ first: owner(0), second: owner(1) })
      })
    ]
  })
}

function fixtureLayer(owners) {
  return buses.pipe(
    Layer.provide(
      HandlerRegistry.layer(
        CommandHandler.make(SeedOwner, ({ index, sessionId, groupId, directory, runId }) =>
          Effect.gen(function* () {
            const { api, root } = owners[index]
            // These are the real application's authenticated commands, with the
            // ordinary contract validation/handlers on each standalone owner.
            yield* command(() =>
              api.sessions.start({
                cwd: root,
                windowKey: `fixture-${runId}`,
                options: {
                  claudeMode: true,
                  launchProfileId: 'dev-echo-adapter',
                  adoptSessionId: sessionId
                }
              })
            )
            yield* command(() =>
              api.sidebar.createGroup({
                windowKey: 'server',
                group: {
                  id: groupId,
                  name: `Personal fleet ${index + 1}`,
                  cwd: root,
                  sessionIds: [sessionId]
                }
              })
            )
            yield* command(() => api.files.createDirectory({ root, path: directory }))
            const file = `${directory}/notes.txt`
            const content = `Owner ${index + 1}, fixture ${runId}`
            yield* command(() => api.files.write({ root, path: file, content }))
            yield* command(() =>
              api.sessions.write(sessionId, { type: 'user_message', text: content })
            )
            return { sessionId, groupId, directory, file, content, root }
          })
        )
      )
    )
  )
}

export async function loadPersonalFleet({ enabled = false, namespace, owners, receipt }) {
  // This fixture is never imported by the application entrypoint. Even an
  // accidental CLI invocation cannot target an arbitrary service or path.
  assert.match(namespace, /^clave-[a-z0-9-]+$/)
  const target = path.join('/tmp', namespace)
  assert.ok(path.resolve(receipt).startsWith(target + path.sep))
  assert.equal(owners.length, 2)
  for (const owner of owners) {
    const url = new URL(owner.url)
    assert.equal(url.protocol, 'http:')
    assert.equal(url.hostname, '127.0.0.1')
    assert.ok(path.resolve(owner.root).startsWith(target + path.sep))
  }
  const clients = owners.map((o) => ({ root: o.root, api: createApiClient(o) }))
  try {
    const fixtures = await Effect.runPromise(personalFleetCatalog().prepare(SCENARIO, {}))
    const report = await Effect.runPromise(
      run({
        fixtures,
        enabled,
        onProgress: (progress) =>
          Effect.sync(() => {
            // A partial run remains inspectable; completed commands are not retried.
            writeFileSync(receipt, JSON.stringify({ scenario: SCENARIO, ...progress }), {
              mode: 0o600
            })
          }),
        ready: ({ values }) =>
          Effect.tryPromise({
            try: async () => {
              for (const [index, value] of [values.first, values.second].entries()) {
                assert.equal(
                  (await clients[index].api.sessions.get(value.sessionId)).id,
                  value.sessionId
                )
                assert.equal(
                  (await clients[index].api.files.read({ root: value.root, path: value.file }))
                    .content,
                  value.content
                )
              }
            },
            catch: () => new Error('Fleet fixture readback failed')
          })
      }).pipe(Effect.provide(fixtureLayer(clients)))
    )
    const result = { scenario: SCENARIO, target: 'isolated standalone loopback', ...report }
    writeFileSync(receipt, JSON.stringify(result, null, 2), { mode: 0o600 })
    return result
  } finally {
    await Promise.all(clients.map(({ api }) => api.dispose()))
  }
}

if (process.argv.includes('--load')) {
  let input
  try {
    input = JSON.parse(readFileSync(0, 'utf8'))
    const result = await loadPersonalFleet(input)
    process.stdout.write(JSON.stringify(result))
  } catch (error) {
    const diagnostic = (input?.owners ?? []).reduce(
      (message, owner) => message.replaceAll(owner.token, '[redacted]'),
      error.message
    )
    process.stderr.write(
      `Personal fleet fixture failed: ${diagnostic}. Inspect its retained progress receipt.\n`
    )
    process.exitCode = 1
  }
}
