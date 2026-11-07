import { createElement, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { DEPTHS, STAGES, ROLES, demand } from './markdown-deep-contract.mjs'

// Three public-renderer repeatability controls, with app-equivalent StrictMode.
// Each value still needs independent literal completeness before equality.
// No source transforms, parser/store callbacks, SSR, debugger or MutationObserver.
let roots = [],
  depth = null,
  ordinal = 0,
  unmountedRoots = 0
const errors = []
const recordError = (kind, error) => errors.push({ kind, message: String(error?.message ?? error) })
window.addEventListener('error', (e) => recordError('window', e.error ?? e.message))
window.addEventListener('unhandledrejection', (e) => recordError('rejection', e.reason))
const frames = () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))

function unmount() {
  const failures = []
  for (const { root, container } of roots) {
    try {
      flushSync(() => root.unmount())
      unmountedRoots++
    } catch (error) {
      failures.push(error.message)
    }
    if (container.childNodes.length) failures.push('Unmount left DOM children')
    container.remove()
  }
  roots = []
  demand(failures.length === 0, failures.join('; '))
}
function start(value) {
  demand(DEPTHS.includes(value), 'undeclared fixture depth')
  unmount()
  depth = value
  ordinal = 0
  roots = ROLES.map((role) => {
    const container = document.createElement('div')
    container.dataset.deepRole = role
    document.body.append(container)
    const root = createRoot(container, {
      onUncaughtError: (e) => recordError('uncaught', e),
      onCaughtError: (e) => recordError('caught', e),
      onRecoverableError: (e) => recordError('recoverable', e)
    })
    return { role, container, root }
  })
}
async function step({ depth: expectedDepth, stage, role, input }) {
  demand(
    expectedDepth === depth &&
      stage === STAGES[Math.floor(ordinal / 3)] &&
      role === ROLES[ordinal % 3],
    'fixture order'
  )
  const { root, container } = roots[ordinal % 3]
  const element = createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, input)
  flushSync(() => root.render(createElement(StrictMode, null, element)))
  await frames()
  const text = container.textContent
  const row = {
    depth,
    stage,
    role,
    renderBoundary: 'ReactMarkdown/remark-gfm',
    comparison: 'literal-correctness-and-repeatability',
    input,
    html: container.innerHTML,
    text,
    em: container.querySelectorAll('em').length,
    strong: container.querySelectorAll('strong').length,
    paragraphsCount: container.querySelectorAll('p').length,
    paragraphs: Array.from(container.querySelectorAll('p'), (p) => p.textContent),
    middleOccurrences: text.split('middle').length - 1,
    connected: container.isConnected,
    errors: errors.map((e) => ({ ...e }))
  }
  ordinal++
  return row
}
function cleanup() {
  unmount()
  return {
    rootsUnmounted: roots.length === 0,
    containersEmpty: !document.querySelector('[data-deep-role]'),
    unmountedRoots,
    errors: [...errors]
  }
}
window.markdownDeepFixture = Object.freeze({ start, step, cleanup })
