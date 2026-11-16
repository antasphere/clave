import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The side panel asks its file watch to RECONCILE: once the watch is set,
 * the panel reads its file one more time, so an edit made between the
 * moment it showed the file and the moment the watch was set is not missed
 * (with the server apart from the app that moment is long enough to lose
 * one edit in six runs of the end-to-end spec). What reconciling does is the
 * hook's, tested in `hooks/use-file-changed.test.ts`; nothing in this suite
 * can mount the panel, so its wiring is pinned by its source, the way
 * `instructions-budget.test.ts` pins the agent instructions.
 */
const source = (name: string): string => readFileSync(join(__dirname, name), 'utf8')

/** The argument text of the first call of `name(` in `text`, by balanced parentheses. */
function callOf(text: string, name: string): string {
  const at = text.indexOf(`${name}(`)
  if (at < 0) return ''
  let depth = 0
  for (let i = at + name.length; i < text.length; i++) {
    if (text[i] === '(') depth++
    else if (text[i] === ')' && --depth === 0) return text.slice(at, i + 1)
  }
  return ''
}

describe("the side panel's watch on its file", () => {
  it('reconciles once the watch is set, and reads from disk only what changed', () => {
    const call = callOf(source('LinkedDocumentPanel.tsx'), 'useFileChanged')
    expect(call).toMatch(/\{\s*reconcile:\s*true\s*\}\s*\)$/)
    // The read it makes is the cheap one: nothing is reloaded when the file
    // is what the panel last loaded or saved, and nothing while a person's
    // edits are pending.
    expect(call).toMatch(/update\(\{\s*reloadExternal:\s*true,\s*ifChanged:\s*true\s*\}\)/)
    expect(call).toMatch(
      /pending\.current\s*\|\|\s*blocked\.current\s*\|\|\s*current\.current\.conflict/
    )
  })

  it('says Saving through the one rule, so the read at open shows nothing', () => {
    // `lib/linked-status.ts` holds the rule (a read from disk saves nothing);
    // the panel must ask it, or every open would flash Saving.
    const panel = source('LinkedDocumentPanel.tsx')
    expect(panel).toMatch(/if \(savesSomething\(input\)\) setStatus\('Saving…'\)/)
    expect(panel.match(/setStatus\('Saving…'\)/g)).toHaveLength(1)
  })

  it('is the only one that asks: a page or a preview is not read again at open', () => {
    for (const name of ['HtmlPage.tsx', 'SlidelessArtefact.tsx'])
      expect(callOf(source(name), 'useFileChanged')).not.toMatch(/reconcile/)
  })
})
