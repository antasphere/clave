import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { waitForAttachmentCaret } from './attachment-caret.mjs'

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function browser() {
  const callbacks = []
  vi.stubGlobal('requestAnimationFrame', (callback) => {
    callbacks.push(callback)
    return callbacks.length
  })
  return {
    win: { evaluate: (fn) => Promise.resolve().then(fn) },
    frame() {
      for (const callback of callbacks.splice(0)) callback(0)
    }
  }
}

describe('the attachment caret before fixture typing', () => {
  it('waits for both frames and clears its deadline when they arrive', async () => {
    const { win, frame } = browser()
    let ready = false
    const completion = waitForAttachmentCaret(win).then(() => (ready = true))
    await vi.advanceTimersByTimeAsync(0)
    expect(ready).toBe(false)
    frame()
    await vi.advanceTimersByTimeAsync(0)
    expect(ready).toBe(false)
    frame()
    await completion
    expect(ready).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('lets an already queued application caret move finish before typing', async () => {
    const { win, frame } = browser()
    const actions = []
    requestAnimationFrame(() => actions.push('caret'))
    const completion = waitForAttachmentCaret(win).then(() => actions.push('type'))
    await vi.advanceTimersByTimeAsync(0)
    frame()
    await vi.advanceTimersByTimeAsync(0)
    expect(actions).toEqual(['caret'])
    frame()
    await completion
    expect(actions).toEqual(['caret', 'type'])
  })

  it('fails closed at ten seconds when frames never arrive', async () => {
    browser()
    let outcome = null
    const completion = waitForAttachmentCaret({ evaluate: () => new Promise(() => {}) }).then(
      () => (outcome = 'passed'),
      (error) => (outcome = error.message)
    )
    await vi.advanceTimersByTimeAsync(9999)
    expect(outcome).toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    expect(outcome).toBe('Attachment caret did not settle in 10000 ms')
    await completion
    expect(vi.getTimerCount()).toBe(0)
  })

  it('propagates a renderer failure and clears the deadline', async () => {
    const error = new Error('renderer unavailable')
    await expect(waitForAttachmentCaret({ evaluate: () => Promise.reject(error) })).rejects.toBe(
      error
    )
    expect(vi.getTimerCount()).toBe(0)
  })

  it('every keyboard sequence after an attachment awaits the frame precondition', () => {
    const file = new URL('../chat-attachments.spec.mjs', import.meta.url)
    const source = ts.createSourceFile(
      file.pathname,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS
    )
    let sequences = 0
    let waits = 0
    const visit = (node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        if (node.expression.text === 'waitForAttachmentCaret') {
          waits++
          expect(ts.isAwaitExpression(node.parent)).toBe(true)
        }
      }
      if (ts.isBlock(node)) {
        for (const [index, statement] of node.statements.entries()) {
          if (!ts.isExpressionStatement(statement) || !ts.isAwaitExpression(statement.expression))
            continue
          const call = statement.expression.expression
          if (
            !ts.isCallExpression(call) ||
            !ts.isPropertyAccessExpression(call.expression) ||
            call.expression.expression.getText(source) !== 'input' ||
            call.expression.name.text !== 'press' ||
            call.arguments[0]?.text !== 'End'
          )
            continue
          sequences++
          const previous = node.statements[index - 1]
          expect(previous?.getText(source)).toBe('await waitForAttachmentCaret(win)')
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    expect(sequences).toBe(4)
    expect(waits).toBe(sequences)
  })
})
