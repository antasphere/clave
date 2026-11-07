import { Effect, Layer, Schema } from 'effect'
import { HandlerRegistry, layer as busesLayer } from '@structure-ai/cqrs'
import { defineFixture, defineScenario, makeCatalog, run } from '@structure-ai/fixtures'

export const PARITY_MARKDOWN = [
  '## Shared design, native interaction',
  '',
  'The **same type and color roles**, with _native touch targets_ and `inline code`.',
  '',
  '- [x] Themes and typography',
  '- [ ] Review tool details',
  '',
  '[Reference link][guide]',
  '',
  '| Item | Result |',
  '| --- | --- |',
  '| A longer label | Ready |',
  '| Ragged row |',
  '',
  '```typescript',
  'const ready: boolean = true',
  'console.log("Shared UI")',
  '```',
  '',
  '> The desktop language, adapted to a phone.',
  '',
  '[guide]: https://example.com/guide'
].join('\n')

/** The supplied ports create/write through the application commands and emit
 * provider output through the recording Echo adapter. Nothing seeds tables or
 * event journals. Each invocation has its own install, workspace and session. */
export async function loadMobileDesktopParity({ create, write, produce, ready, imageUrl }) {
  const scenario = defineScenario({
    name: 'mobile/desktop-parity',
    description:
      'A shared desktop and phone conversation with Markdown, ragged tables, code and tools.',
    input: Schema.Struct({}),
    fixtures: () => ({
      conversation: defineFixture({
        key: 'mobile/desktop-parity/conversation',
        create: ({ runId }) =>
          Effect.promise(async () => {
            const conversation = await create(runId)
            await write(conversation, 'Review the shared UI on desktop and phone.')
            await produce(conversation, [
              {
                type: 'assistant_text',
                delta: PARITY_MARKDOWN + (imageUrl ? `\n\n![Shared UI preview](${imageUrl})` : ''),
                final: true
              },
              {
                type: 'tool_call',
                id: `${runId}-read`,
                name: 'Read',
                input: { file_path: '/fixture/view.tsx' }
              },
              { type: 'tool_result', id: `${runId}-read`, output: 'export const ready = true' },
              {
                type: 'tool_call',
                id: `${runId}-test`,
                name: 'Bash',
                input: { command: 'npm test' }
              },
              { type: 'tool_result', id: `${runId}-test`, output: 'All fixture checks passed.' },
              {
                type: 'assistant_text',
                delta: 'The shared controls are ready for a visual review.',
                final: true
              }
            ])
            return conversation
          })
      })
    })
  })
  return Effect.runPromise(
    makeCatalog({ base: {}, scenarios: [scenario] })
      .prepare(scenario.name, {})
      .pipe(
        Effect.flatMap((fixtures) =>
          run({
            fixtures,
            enabled: true,
            ready: ({ values }) => Effect.promise(() => ready(values.conversation)),
            timeoutMs: 120000
          })
        ),
        Effect.provide(busesLayer.pipe(Layer.provide(HandlerRegistry.layer())))
      )
  )
}
