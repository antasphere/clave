import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { openChat, inject, TOOL_RESULT } from '../e2e/chat-view.spec.mjs'

const css = readFileSync(
  new URL('../../packages/ui/src/system.css', import.meta.url),
  'utf8'
).split('/* ── Conversation views')[1]
assert.ok(css, 'conversation classes exist')
assert.doesNotMatch(
  css,
  /#[\da-f]{3,8}\b|rgba?\(|hsla?\(|\b\d+(?:\.\d+)?(?:px|rem|ms)\b/i,
  'chat styles must use tokens, never literal color/size/duration'
)
const fixture = await openChat('chat-visual')
try {
  const { app, win, record } = fixture
  await inject(app, record.id, [
    { type: 'user_message', text: 'Explain the change.' },
    {
      type: 'assistant_text',
      delta:
        'A **native conversation** with a table.\n\n| File | Status |\n| --- | --- |\n| view.tsx | Ready |\n\n```typescript\nconst ready = true\n```',
      final: true
    },
    { type: 'tool_call', id: 'read', name: 'Read', input: { path: '/tmp/example' } },
    { type: 'tool_result', id: 'read', output: TOOL_RESULT },
    {
      type: 'permission_request',
      id: 'p',
      description: 'Allow this edit?',
      options: [
        { id: 'yes', label: 'Allow' },
        { id: 'no', label: 'Deny' }
      ]
    }
  ])
  await win.locator('.chat-permission-card').waitFor()
  await win.locator('code.language-typescript span[style]').first().waitFor()
  await win.locator('.chat-tool-card summary').click()
  const colors = new Set()
  for (const theme of ['dark', 'light', 'coffee', 'charcoal']) {
    await win.evaluate((theme) => {
      return window.electronAPI.skinsActivate(theme)
    }, theme)
    await win.waitForFunction((theme) => localStorage.getItem('clave-theme') === theme, theme)
    const values = await win.locator('.chat-view').evaluate((el) => {
      const style = getComputedStyle(el)
      const user = getComputedStyle(el.querySelector('[data-role="user"]'))
      const header = getComputedStyle(el.closest('.chat-host').querySelector('.chat-header'))
      const frames = ['.chat-tool-card', '.chat-permission-card', '.chat-card-body'].map(
        (selector) => {
          const frame = getComputedStyle(el.querySelector(selector))
          return { width: parseFloat(frame.borderTopWidth), style: frame.borderTopStyle }
        }
      )
      return {
        headerBorder: {
          width: parseFloat(header.borderBottomWidth),
          style: header.borderBottomStyle
        },
        frames,
        color: style.color,
        expected: style.getPropertyValue('--text-primary').trim(),
        font: style.fontFamily,
        background: user.backgroundColor,
        overflow: el.scrollWidth > el.clientWidth
      }
    })
    for (const border of [values.headerBorder, ...values.frames]) {
      assert.ok(border.width > 0, `${theme}: header and card borders paint`)
      assert.equal(border.style, 'solid', `${theme}: header and card borders are solid`)
    }
    assert.match(values.font, /Geist/)
    assert.equal(values.overflow, false, `${theme}: view does not overflow`)
    colors.add(values.background)
    assert.equal(await win.locator('.chat-tool-card pre').last().innerText(), TOOL_RESULT)
    assert.ok(await win.getByRole('button', { name: 'Allow', exact: true }).isVisible())
    // Screenshot bytes remain in memory, never in the project or baseline tree.
    const screenshot = await win.locator('.chat-host').screenshot()
    assert.ok(screenshot.length > 1000, `${theme}: rendered screenshot is not empty`)
    console.log(`PASS ${theme}: transcript, composer and permission card rendered`)
  }
  assert.equal(colors.size, 4, 'all four skins supply distinct user-turn grounds')
} finally {
  await fixture.close()
}
