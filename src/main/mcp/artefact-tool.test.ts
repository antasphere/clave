import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import {
  OPEN_ARTEFACT_DESCRIPTION_DESKTOP,
  OPEN_ARTEFACT_DESCRIPTION_SERVER,
  SIDE_PANEL_HTML_REFUSAL,
  openArtefactSchema,
  openedAnswer,
  sidePanelRefusal
} from './artefact-tool'

/**
 * `clave_open_artefact` and the side panel's refusal (PRDCT-4472). The
 * desktop's MCP server (`mcp-server.ts`) has no unit tests of its tools (it
 * needs Electron), so the rule it applies is this pure function, and the
 * source is read to prove it is applied first.
 */
const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

describe('the side panel refuses what is an artefact now', () => {
  it('refuses a path ending in .html or .htm, in any case, and an existing folder', () => {
    const root = mkdtempSync(join(tmpdir(), 'clave-side-panel-'))
    dirs.push(root)
    mkdirSync(join(root, 'deck'))
    writeFileSync(join(root, 'notes.md'), '# notes')
    expect(sidePanelRefusal('/work/page.html')).toBe(SIDE_PANEL_HTML_REFUSAL)
    expect(sidePanelRefusal('/work/page.HTM')).toBe(SIDE_PANEL_HTML_REFUSAL)
    expect(sidePanelRefusal('/work/missing-page.Html')).toBe(SIDE_PANEL_HTML_REFUSAL)
    expect(sidePanelRefusal(join(root, 'deck'))).toBe(SIDE_PANEL_HTML_REFUSAL)
    expect(sidePanelRefusal(join(root, 'notes.md'))).toBeNull()
    expect(sidePanelRefusal(join(root, 'missing-folder'))).toBeNull()
    expect(sidePanelRefusal('/work/page.html.md')).toBeNull()
    expect(sidePanelRefusal(undefined)).toBeNull()
    expect(SIDE_PANEL_HTML_REFUSAL).toBe(
      'An HTML page or a folder opens with clave_open_artefact, not in the side panel.'
    )
  })

  it('is applied by the desktop side panel before anything else, and its description says no HTML', () => {
    const src = readFileSync(join(__dirname, 'mcp-server.ts'), 'utf8')
    const at = src.indexOf("'clave_open_side_panel',")
    expect(at).toBeGreaterThan(0)
    const tool = src.slice(at, src.indexOf('server.registerTool(', at))
    const handler = tool.slice(tool.indexOf('async (args) => {'))
    expect(handler.indexOf('sidePanelRefusal(args.path)')).toBeGreaterThan(0)
    expect(handler.indexOf('sidePanelRefusal(args.path)')).toBeLessThan(
      handler.indexOf('callerSessionId')
    )
    expect(tool).not.toContain('Slideless')
    expect(tool).not.toContain('pass a FOLDER')
    expect(tool).not.toContain('Reopening a path')
  })
})

describe('clave_open_artefact', () => {
  it('answers opened, the title and the page', () => {
    expect(
      openedAnswer({
        title: 'deck',
        page: '/work/deck/index.html'
      })
    ).toEqual({ opened: true, title: 'deck', page: '/work/deck/index.html' })
  })

  it('answers that the presentation was requested when it was asked to present (PRDCT-4980)', () => {
    const page = { title: 'deck', page: '/work/deck/index.html' }
    expect(openedAnswer(page, true)).toEqual({ ...openedAnswer(page), present: 'requested' })
    expect(openedAnswer(page, false)).toEqual(openedAnswer(page))
    expect(Object.keys(openedAnswer(page, false))).not.toContain('present')
  })

  it('takes present, an optional boolean, and says when to pass it on both servers', () => {
    const input = z.object(openArtefactSchema)
    expect(input.parse({ path: '/work/deck' })).toEqual({ path: '/work/deck' })
    expect(input.parse({ path: '/work/deck', present: true })).toEqual({
      path: '/work/deck',
      present: true
    })
    expect(input.safeParse({ path: '/work/deck', present: 'yes' }).success).toBe(false)
    for (const description of [
      OPEN_ARTEFACT_DESCRIPTION_DESKTOP,
      OPEN_ARTEFACT_DESCRIPTION_SERVER
    ]) {
      expect(description).toContain('"present it"')
      expect(description).toContain('full screen')
      expect(description).toContain('present: true')
      expect(description).toContain('on another display when one is connected')
      expect(description).not.toContain('external display')
    }
  })

  it('passes present on in the standalone server too', () => {
    const src = readFileSync(join(__dirname, 'standalone-mcp.ts'), 'utf8')
    expect(src).toMatch(/async \(\{ path, present \}\)/)
    expect(src).toMatch(/artefacts\.open\(sessionId, path, true\)/)
  })

  it('reads the same on the desktop, beside YOUR session and on this Mac', () => {
    expect(OPEN_ARTEFACT_DESCRIPTION_DESKTOP).toBe(
      OPEN_ARTEFACT_DESCRIPTION_SERVER.replace(
        'beside YOUR session, on every Mac attached to this server.',
        'beside YOUR session.'
      ).replace(/this server/g, 'this Mac')
    )
    expect(OPEN_ARTEFACT_DESCRIPTION_DESKTOP).not.toMatch(/server/)
  })

  it('is registered on the desktop with the shared name, input and description', () => {
    const src = readFileSync(join(__dirname, 'mcp-server.ts'), 'utf8')
    expect(src).toMatch(
      /OPEN_ARTEFACT_TOOL,\s*\{ description: OPEN_ARTEFACT_DESCRIPTION_DESKTOP, inputSchema: openArtefactSchema \}/
    )
    expect(src).toMatch(/api\.artefacts\.open\(callerSessionId, target, present === true\)/)
    expect(src).toMatch(/openedAnswer\(artefact, present\)/)
  })
})
