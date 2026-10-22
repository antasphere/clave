/* eslint-disable react/prop-types -- fixed plain JavaScript test-fixture props */
import React, { StrictMode, Suspense, startTransition } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { usePresentation } from '../../plugins/chat-view/src/presentation'
import { emptyConversation, reduceConversation } from '../../plugins/chat-view/src/reducer'

// This isolated real React fixture observes browser timers, not fake hooks or
// a substitute schedule. It is functional evidence, never a heap workload.
const activeTimers = new Set()
const nativeSet = window.setTimeout.bind(window)
const nativeClear = window.clearTimeout.bind(window)
window.setTimeout = (callback, ms, ...args) => {
  const id = nativeSet(() => {
    activeTimers.delete(id)
    callback(...args)
  }, ms)
  activeTimers.add(id)
  return id
}
window.clearTimeout = (id) => {
  activeTimers.delete(id)
  nativeClear(id)
}
const caught = [],
  errors = []
const root = createRoot(document.getElementById('root'), {
  onCaughtError: (e) => caught.push(e.message),
  onUncaughtError: (e) => errors.push(e.message),
  onRecoverableError: (e) => errors.push(e.message)
})
let values = [emptyConversation, emptyConversation],
  visible = true,
  generation = 0,
  mode = null
const never = new Promise(() => {})
class Boundary extends React.Component {
  state = { error: false }
  static getDerivedStateFromError() {
    return { error: true }
  }
  render() {
    return this.state.error ? React.createElement('output', null, 'caught') : this.props.children
  }
}
function fault() {
  if (mode === 'parser') {
    const parser = this.parser
    this.parser = (document, file) => {
      parser(document, file)
      throw new Error('real parser failure')
    }
  }
  if (mode === 'downstream')
    return () => {
      throw new Error('real downstream failure')
    }
}
function Block() {
  if (mode === 'suspend') throw never
  return null
}
function Row({ value, index }) {
  const presented = usePresentation(value, visible)
  return React.createElement(
    'article',
    { 'data-row': index },
    presented.entries.map((entry, n) =>
      React.createElement(ReactMarkdown, { key: n, remarkPlugins: [remarkGfm, fault] }, entry.text)
    ),
    React.createElement(Block)
  )
}
const render = () =>
  root.render(
    React.createElement(
      StrictMode,
      null,
      React.createElement(
        Boundary,
        { key: generation },
        React.createElement(
          Suspense,
          { fallback: React.createElement('output', null, 'suspended') },
          values.map((value, index) => React.createElement(Row, { key: index, value, index }))
        )
      )
    )
  )
window.fullLifecycle = {
  start(text = 'Earlier\n\nMutable') {
    mode = null
    visible = true
    generation++
    values = [0, 1].map((i) =>
      reduceConversation(
        reduceConversation(emptyConversation, {
          event: { type: 'state_change', state: 'working' }
        }),
        {
          event: { type: 'assistant_text', delta: text + (i ? ' second' : ''), final: false },
          at: 1
        }
      )
    )
    flushSync(render)
  },
  append(delta, options = {}) {
    values = values.map((v, i) =>
      i
        ? v
        : reduceConversation(v, {
            event: { type: 'assistant_text', delta, final: !!options.final },
            at: 1
          })
    )
    if (options.control)
      values[0] = reduceConversation(values[0], {
        event: { type: 'session_meta', model: 'changed', providerSessionId: null }
      })
    mode = options.mode || null
    if (options.transition) startTransition(render)
    else flushSync(render)
  },
  visibility(value) {
    visible = value
    flushSync(render)
  },
  replacement(text) {
    generation++
    mode = null
    values[0] = reduceConversation(emptyConversation, {
      event: { type: 'assistant_text', delta: text, final: true },
      at: 2
    })
    flushSync(render)
  },
  snapshot() {
    return {
      html: [...document.querySelectorAll('article')].map((e) => e.innerHTML),
      timers: activeTimers.size,
      caught: [...caught],
      errors: [...errors]
    }
  },
  unmount() {
    flushSync(() => root.unmount())
    return {
      children: document.getElementById('root').childNodes.length,
      timers: activeTimers.size,
      errors: [...errors]
    }
  }
}
