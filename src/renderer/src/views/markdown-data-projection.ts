import { Fragment, isValidElement } from 'react'
import { demand } from '../../../../tests/e2e/markdown-deep-contract.mjs'

// Pure test data projection, shared by the current and legacy pipeline oracles.
// Every sorted key, array length and typed value remains represented.
export function project(value: unknown): unknown[] {
  const result: unknown[] = []
  type Frame = { kind: 'visit'; value: unknown } | { kind: 'leave'; value: object }
  const pending: Frame[] = [{ kind: 'visit', value }]
  const ancestors = new WeakSet<object>()
  while (pending.length) {
    const item = pending.pop()!
    if (item.kind === 'leave') {
      ancestors.delete(item.value)
      continue
    }
    let current = item.value
    if (current && typeof current === 'object') {
      demand(!ancestors.has(current), 'cyclic projection')
      ancestors.add(current)
      pending.push({ kind: 'leave', value: current })
    }
    if (isValidElement<Record<string, unknown>>(current)) {
      demand(typeof current.type === 'string' || current.type === Fragment, 'unsupported JSX type')
      current = {
        element: current.type === Fragment ? 'Fragment' : current.type,
        key: current.key,
        props: current.props
      }
    }
    if (current === null || ['undefined', 'string', 'number', 'boolean'].includes(typeof current)) {
      // JSON otherwise aliases NaN/Infinity and drops the sign of zero.
      const exact =
        typeof current === 'number' ? (Object.is(current, -0) ? '-0' : String(current)) : current
      result.push(['value', typeof current, exact])
      continue
    }
    demand(typeof current === 'object' && current !== null, 'unsupported projected value')
    const object = current as Record<string, unknown>
    demand(
      Array.isArray(object) || [Object.prototype, null].includes(Object.getPrototypeOf(object)),
      'unsupported projected prototype'
    )
    demand(Object.getOwnPropertySymbols(object).length === 0, 'symbol-keyed projection')
    const keys = Object.keys(object).sort()
    // The ordered key list declares the exact number of child tokens/subtrees.
    // Structure and array length remain explicit without repeating ancestor paths.
    result.push([
      Array.isArray(object) ? 'array' : 'object',
      keys,
      Array.isArray(object) ? object.length : null
    ])
    // Preserve the original eager reverse-key getter reads before child traversal.
    for (let i = keys.length - 1; i >= 0; i--)
      pending.push({ kind: 'visit', value: object[keys[i]] })
  }
  return result
}
