// Debugger-only functional diagnostic. Never run freshness/reveal timing while
// these breakpoints are attached. The actual production bundle is not edited.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { REPO } from './harness.mjs'

export async function observeNativeParser(win) {
  const assets = path.join(REPO, 'out/renderer/assets')
  const candidates = readdirSync(assets).filter(
    (name) =>
      name.endsWith('.js') &&
      readFileSync(path.join(assets, name), 'utf8').includes('function createMarkdownAttempt(')
  )
  assert.equal(candidates.length, 1, 'one actual built parser boundary')
  const name = candidates[0],
    source = readFileSync(path.join(assets, name), 'utf8')
  const boundaryStart = source.indexOf('function createMarkdownAttempt(')
  const boundaryEnd = source.indexOf('return { plugin, ready:', boundaryStart)
  const base = /let (\w+) = committed;/.exec(source.slice(boundaryStart, boundaryEnd))?.[1]
  assert.ok(base && boundaryEnd > boundaryStart, 'actual retained-state scope identified')
  const remarkStart = source.indexOf('function remarkParse(')
  const parserStart = source.indexOf('  function parser(', remarkStart)
  const parserBody = source.indexOf('    return fromMarkdown(', parserStart)
  assert.ok(remarkStart > 0 && parserStart > remarkStart && parserBody > parserStart)
  const line = (offset) => source.slice(0, offset).split('\n').length - 1
  const range = [line(boundaryStart), line(boundaryEnd)]
  const cdp = await win.context().newCDPSession(win)
  const entries = []
  let phase = 'setup',
    failure,
    breakpointId
  const paused = async (event) => {
    try {
      const caller = event.callFrames.find(
        (f) => f.location.lineNumber >= range[0] && f.location.lineNumber <= range[1]
      )
      // ReactMarkdown outside this boundary is not evidence for native reuse.
      assert.ok(caller, 'actual engine entered through the native parser boundary')
      const raw = await cdp.send('Debugger.evaluateOnCallFrame', {
        callFrameId: event.callFrames[0].callFrameId,
        expression: '({length:arguments[0].length,fullLength:String(arguments[1].value).length})',
        returnByValue: true
      })
      const metadata = await cdp.send('Debugger.evaluateOnCallFrame', {
        callFrameId: caller.callFrameId,
        expression: `({inputLength:input.length,final,baseKind:${base}?.kind ?? null,cut:${base}?.kind === 'prefix' ? ${base}.snapshot.cut : null,fullFile:file.value===input})`,
        returnByValue: true
      })
      assert.equal(raw.exceptionDetails, undefined)
      assert.equal(metadata.exceptionDetails, undefined)
      entries.push({ phase, ...raw.result.value, ...metadata.result.value })
    } catch (error) {
      failure = error
    } finally {
      await cdp.send('Debugger.resume').catch(() => {})
    }
  }
  try {
    await cdp.send('Debugger.enable')
    const result = await cdp.send('Debugger.setBreakpointByUrl', {
      urlRegex: name.replaceAll('.', '\\.') + '$',
      lineNumber: line(parserBody)
    })
    breakpointId = result.breakpointId
    assert.ok(result.locations.length > 0, 'actual installed parser breakpoint is bound')
    cdp.on('Debugger.paused', paused)
    return {
      phase(value) {
        phase = value
      },
      read() {
        if (failure) throw failure
        assert.ok(
          entries.every((e) => e.fullFile && e.fullLength === e.inputLength),
          'actual native parser receives the complete canonical VFile'
        )
        return entries.map((entry) => ({ ...entry }))
      },
      async detach() {
        await cdp.send('Debugger.removeBreakpoint', { breakpointId })
        cdp.off('Debugger.paused', paused)
        await cdp.detach()
        if (failure) throw failure
      }
    }
  } catch (error) {
    if (breakpointId) await cdp.send('Debugger.removeBreakpoint', { breakpointId }).catch(() => {})
    await cdp.detach()
    throw error
  }
}
