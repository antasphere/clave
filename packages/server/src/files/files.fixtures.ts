/** Reusable file-domain scenario. The fleet acceptance lane composes the same
 * real commands on its two owners; this scenario adds no fixture-only route. */
import { Effect, Schema } from 'effect'
import { defineFixture, defineScenario, makeCatalog } from '@structure-ai/fixtures'
import { CreateDirectory, PrepareFileAttachment, WriteFile } from '@clave/contract/files'

export const fileFixtureCatalog = makeCatalog({
  base: {},
  scenarios: [
    defineScenario({
      name: 'remote-files/owned-content',
      description: 'Run-scoped editable text and a durable uploaded image on one owner.',
      input: Schema.Struct({ root: Schema.NonEmptyString }),
      fixtures: ({ root }) => ({
        content: defineFixture({
          key: 'remote-files/content',
          create: ({ dispatch, id }) =>
            Effect.gen(function* () {
              const directory = id('directory')
              yield* dispatch(CreateDirectory, { root, path: directory })
              const path = `${directory}/notes.txt`
              yield* dispatch(WriteFile, { root, path, content: 'Editable on the owning server.' })
              const sessionId = id('session')
              const attachment = yield* dispatch(PrepareFileAttachment, {
                sessionId,
                source: {
                  kind: 'upload',
                  name: 'Fixture.png',
                  image: true,
                  base64:
                    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
                }
              })
              return { root, path, directory, sessionId, attachment }
            })
        })
      })
    })
  ]
})
