/**
 * An OpenCode chat's `execute` card shows what it ran (PRDCT-4507). OpenCode
 * 2.3.0 reaches Clave's tools through its code mode: the model runs a script
 * in the `execute` tool. The card read `execute` with `Input {}`; with the
 * script that arrives later (acp-adapter.ts), the row says it ran code and
 * which Clave tools it calls, and the panel shows the script.
 */
import { describe, expect, it } from 'vitest'
import { claveToolsInScript, describeTool, describeToolHead, sectionLanguage } from './tools'
import type { ToolEntry } from './tools'

// What the real `opencode acp` 2.3.0 sent as the call's `rawInput` (made-up model).
const SCRIPT =
  'const found = await search({ query: "list tabs" }); const r = await tools.clave.clave_list({}); return r'

const tool = (over: Partial<ToolEntry>): ToolEntry => ({
  kind: 'tool',
  id: 'call_x',
  name: 'execute',
  input: { code: SCRIPT },
  complete: true,
  output: 'stand-in answer',
  at: 1,
  ...over
})

describe('an execute card shows the script and the Clave tools it calls (PRDCT-4507)', () => {
  it('names each Clave tool a script calls, once, in order, whatever the spelling', () => {
    expect(claveToolsInScript(SCRIPT)).toEqual(['clave_list'])
    expect(
      claveToolsInScript(
        'await tools.clave.clave_open_session({ mode: "pi" })\nawait tools["clave"]["clave_list"]()\nawait tools.clave.clave_open_session({})'
      )
    ).toEqual(['clave_open_session', 'clave_list'])
    expect(claveToolsInScript('await tools.other.thing(); await search({ query: "x" })')).toEqual(
      []
    )
  })

  it('says it ran code calling the Clave tool, and shows the script as JavaScript then the output', () => {
    expect(describeToolHead(tool({}))).toEqual({
      kind: 'other',
      label: 'Ran code',
      target: 'calling clave_list'
    })
    const description = describeTool(tool({}))
    expect(description.sections).toEqual([
      { label: 'Code', text: SCRIPT },
      { label: 'Output', text: 'stand-in answer' }
    ])
    expect(sectionLanguage(description.kind, description.sections[0], description.target)).toBe(
      'javascript'
    )
  })

  it('a script that calls no Clave tool reads by its first line; one not arrived yet stays a plain call', () => {
    expect(describeToolHead(tool({ input: { code: 'return 1 + 1\nreturn 2' } })).target).toBe(
      'return 1 + 1'
    )
    // Before the script arrives the call is shown as OpenCode opened it.
    expect(describeToolHead(tool({ input: {}, complete: false }))).toMatchObject({
      label: 'execute'
    })
  })
})
