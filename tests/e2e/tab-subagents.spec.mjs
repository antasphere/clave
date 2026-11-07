// A tab whose turn has ended while its subagents still run reads working, not
// done: the sidebar row's spinner turns with the subagents' count inside its
// ring, and the row carries no "N running" counter: a command left running is
// named in the status glyph's tooltip instead. When the subagents end, the
// tab comes to rest on its check.
import { openChat, inject } from './chat-view.spec.mjs'
import { until } from './harness.mjs'

const task = (id, kind) => ({ id, kind, description: `${kind} ${id}`, startedAt: Date.now() })

export async function run(t) {
  const chat = await openChat('tab-subagents')
  const { win, record, fixture } = chat
  try {
    const row = `[data-sidebar-item-id="${record.id}"]`
    const read = () =>
      win.evaluate((row) => {
        const status = document.querySelector(`${row} .sidebar-tab-status`)
        return {
          status: status?.getAttribute('data-status'),
          glyph: status?.getAttribute('data-glyph'),
          agents: document.querySelector(`${row} .sidebar-tab-agents`)?.textContent ?? null,
          counter: document.querySelectorAll(`${row} .tab-background-count`).length,
          label: status?.getAttribute('aria-label')
        }
      }, row)

    await inject(fixture, record.id, [
      { type: 'state_change', state: 'working' },
      { type: 'state_change', state: 'done' },
      {
        type: 'background_tasks',
        tasks: [task('a1', 'agent'), task('a2', 'agent'), task('s1', 'shell')]
      }
    ])
    const lane = await until(async () => {
      const r = await read()
      return r.agents === '2' ? r : null
    })
    t.check(
      'turn over, subagents running: the row reads working',
      lane?.status === 'working' && lane?.glyph === 'spinner',
      lane
    )
    t.equal('with the subagents counted inside the spinner', lane?.agents, '2')
    t.equal('no "running" counter on the row', lane?.counter, 0)
    t.equal('and the tooltip says so', lane?.label, 'Working · 2 subagents running')

    await inject(fixture, record.id, [{ type: 'background_tasks', tasks: [task('s1', 'shell')] }])
    const rest = await until(async () => {
      const r = await read()
      return r.status !== 'working' ? r : null
    })
    t.check(
      'the subagents done, the tab rests on its check',
      rest?.glyph === 'check' && rest?.agents === null,
      rest
    )
    t.equal('the shell named in the tooltip', rest?.label, 'Finished · 1 command still running')
    t.equal('still no counter on the row', rest?.counter, 0)
  } finally {
    await chat.close()
  }
}
