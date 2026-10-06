// The conversation the fake `claude` plays in the "Lane · checkout" chat tab.
// One entry per user message. Frames are stream-json, shaped like the recorded
// turns in src/main/sessions/fixtures/claude-stream/. `{ pause: true }` stops
// the turn until the host answers a permission (control_response).
//
// Edit the words here to change what the chat shots show.

const MODEL = 'claude-opus-5'
// Relative paths: the shots never show the fixture's /tmp location.
const file = (rel) => rel

let msg = 0
const usage = (input) => ({
  input_tokens: 4,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: input,
  output_tokens: 180,
  service_tier: 'standard'
})
/** One assistant message: start, the full message, stop (as the CLI sends). */
function assistant(content, context, delay = 120) {
  const id = `msg_shots_${++msg}`
  return [
    {
      type: 'stream_event',
      event: {
        type: 'message_start',
        message: { id, type: 'message', role: 'assistant', model: MODEL, content: [] }
      },
      parent_tool_use_id: null,
      delay
    },
    {
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        id,
        type: 'message',
        role: 'assistant',
        model: MODEL,
        content,
        usage: usage(context)
      }
    },
    { type: 'stream_event', event: { type: 'message_stop' }, parent_tool_use_id: null }
  ]
}
const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input })
const results = (...items) => ({
  type: 'user',
  parent_tool_use_id: null,
  message: {
    role: 'user',
    content: items.map(([id, content]) => ({ type: 'tool_result', tool_use_id: id, content }))
  }
})

const ANSWER = `## Address validation is in

The checkout form now checks the shipping address before it creates the order draft.

- **Postal code** is checked against the selected country's format
- **Street** and **city** are required and trimmed
- Errors show inline under each field and focus moves to the first one
- \`validateAddress()\` lives in \`src/lib/validate.ts\` and is shared with the API route

\`\`\`ts
const check = validateAddress(shipping)
if (!check.ok) return showErrors(check)
\`\`\`

All **41 tests pass**, including 6 new cases for the address rules.`

const turns = [
  // 1. "Add address validation to the checkout form and run the tests"
  [
    ...assistant(
      [
        { type: 'text', text: "I'll read the checkout form and the validation helpers first." },
        toolUse('toolu_shots_read1', 'Read', { file_path: file('src/checkout/CheckoutForm.tsx') }),
        toolUse('toolu_shots_read2', 'Read', { file_path: file('src/lib/validate.ts') })
      ],
      18200
    ),
    results(
      [
        'toolu_shots_read1',
        '1\texport function CheckoutForm({ cart }: Props) {\n2\t  const [shipping, setShipping] = useState(emptyAddress)\n…'
      ],
      ['toolu_shots_read2', '1\texport function validateEmail(value: string) {\n…']
    ),
    ...assistant(
      [
        toolUse('toolu_shots_edit1', 'Edit', {
          file_path: file('src/lib/validate.ts'),
          old_string: 'export function validateEmail(',
          new_string:
            'export function validateAddress(address: Address): ValidationResult {\n  const errors = collectAddressErrors(address)\n  return errors.length ? { ok: false, errors } : { ok: true }\n}\n\nexport function validateEmail('
        }),
        toolUse('toolu_shots_edit2', 'Edit', {
          file_path: file('src/checkout/CheckoutForm.tsx'),
          old_string: '  onSubmit(shipping)',
          new_string:
            '  const result = validateAddress(shipping)\n  if (!result.ok) return showFieldErrors(result.errors)\n  onSubmit(shipping)'
        })
      ],
      24100
    ),
    results(
      [
        'toolu_shots_edit1',
        `The file ${file('src/lib/validate.ts')} has been updated successfully.`
      ],
      [
        'toolu_shots_edit2',
        `The file ${file('src/checkout/CheckoutForm.tsx')} has been updated successfully.`
      ]
    ),
    ...assistant(
      [
        toolUse('toolu_shots_bash1', 'Bash', {
          command: 'npm test',
          description: 'Run the test suite'
        })
      ],
      26900
    ),
    results([
      'toolu_shots_bash1',
      '> atelier-nord-shop@0.4.0 test\n> vitest run\n\n ✓ src/lib/validate.test.ts (18 tests)\n ✓ src/checkout/CheckoutForm.test.tsx (14 tests)\n ✓ src/cart/cart.test.ts (9 tests)\n\n Test Files  3 passed (3)\n      Tests  41 passed (41)\n   Duration  1.84s'
    ]),
    ...assistant([{ type: 'text', text: ANSWER }], 29400),
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: 48210,
      num_turns: 4,
      result: ANSWER,
      modelUsage: { [MODEL]: { contextWindow: 200000 } }
    }
  ],
  // 2. A follow-up that stops on a permission request (permission-turn shape).
  [
    ...assistant(
      [
        {
          type: 'text',
          text: "I'll store the validated address on the order draft so the payment step can reuse it."
        },
        toolUse('toolu_shots_edit3', 'Edit', {
          file_path: file('src/checkout/orderDraft.ts'),
          old_string: '  shipping: null,',
          new_string: '  shipping: normalizeAddress(validated),'
        })
      ],
      31000
    ),
    {
      type: 'control_request',
      request_id: 'shots-permission-1',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Edit',
        display_name: 'Edit',
        input: {
          file_path: file('src/checkout/orderDraft.ts'),
          old_string: '  shipping: null,',
          new_string: '  shipping: normalizeAddress(validated),'
        },
        permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
        tool_use_id: 'toolu_shots_edit3'
      }
    },
    { pause: true }
  ]
]

module.exports = { turns, MODEL }
