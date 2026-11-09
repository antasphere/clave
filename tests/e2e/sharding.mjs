import { readFileSync } from 'node:fs'

function checkDurationHints(hints) {
  const positive = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0
  if (
    !positive(hints?.defaultSeconds) ||
    !hints.seconds ||
    typeof hints.seconds !== 'object' ||
    Array.isArray(hints.seconds)
  )
    throw new Error(
      'Invalid E2E shard duration hints: expected positive defaultSeconds and seconds map'
    )
  for (const [name, seconds] of Object.entries(hints.seconds)) {
    if (!name.endsWith('.spec.mjs') || !positive(seconds))
      throw new Error(`Invalid E2E shard duration hint: ${name}`)
  }
  return hints
}

// Both the runner and the aggregate read the same checkout-static hints. Never
// learn placement from this run's reports, environment or host characteristics.
const durationHints = checkDurationHints(
  JSON.parse(readFileSync(new URL('./shard-durations.json', import.meta.url), 'utf8'))
)

// Keep selection independent of Electron, so coverage can be checked on any host.
export function parseRunArgs(args) {
  const options = { filters: [], shard: { index: 1, total: 1 }, report: null, list: false }
  const seen = new Set()
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg.startsWith('--')) {
      if (arg.trim()) options.filters.push(arg)
      continue
    }
    const [key, ...rest] = arg.slice(2).split('=')
    if (!['shard', 'report', 'list'].includes(key) || seen.has(key))
      throw new Error(`Unknown or duplicate option: ${arg}`)
    seen.add(key)
    if (key === 'list') {
      if (rest.length) throw new Error('--list takes no value')
      options.list = true
      continue
    }
    const value = rest.length ? rest.join('=') : args[++i]
    if (!value || value.startsWith('--')) throw new Error(`--${key} needs a value`)
    if (key === 'report') options.report = value
    else {
      if (!/^[1-9]\d*\/[1-9]\d*$/.test(value)) throw new Error(`Invalid shard: ${value}`)
      const [index, total] = value.split('/').map(Number)
      if (!Number.isSafeInteger(index) || !Number.isSafeInteger(total) || index > total)
        throw new Error(`Invalid shard: ${value}`)
      options.shard = { index, total }
    }
  }
  return options
}

// These specs use the host's real pasteboard. Keep them sequential even when
// several workers share one Mac; fixture namespaces cannot isolate a clipboard.
export const CLIPBOARD_SPECS = new Set([
  'chat-view.spec.mjs',
  'chat-turn-copy.spec.mjs',
  'copy-contents.spec.mjs',
  'copy-session-id.spec.mjs',
  'session-menu.spec.mjs',
  'triage-ui.spec.mjs'
])
export function selectShard(specs, { index, total }, hints = durationHints) {
  checkDurationHints(hints)
  // A large requested shard count must not allocate more bins than specs.
  const loads = Array(Math.min(total, specs.length)).fill(0)
  const placement = new Map()
  const pending = []
  for (const [order, name] of specs.entries()) {
    const seconds = Object.hasOwn(hints.seconds, name) ? hints.seconds[name] : hints.defaultSeconds
    if (CLIPBOARD_SPECS.has(name)) {
      placement.set(name, 0)
      loads[0] += seconds
    } else pending.push({ name, seconds, order })
  }
  pending.sort((a, b) => b.seconds - a.seconds || a.order - b.order)
  for (const { name, seconds } of pending) {
    let target = 0
    for (let i = 1; i < loads.length; i++) {
      if (loads[i] < loads[target]) target = i
    }
    placement.set(name, target)
    loads[target] += seconds
  }
  // Hints choose placement only. Preserve the runner's original order within
  // each shard, including the unchanged sequential 1/1 invocation.
  return specs.filter((name) => placement.get(name) === index - 1)
}

// A normal assertion failure is still a report in CI. Missing execution is not.
export function validateReports(reports, specs, total) {
  const fail = (detail) => {
    throw new Error(`Incomplete E2E run: ${detail}`)
  }
  if (reports.length !== total) fail(`expected ${total} reports, got ${reports.length}`)
  const seen = new Set()
  const executed = []
  for (const r of reports) {
    const index = r?.shard?.index
    if (
      r?.version !== 1 ||
      !r.completed ||
      r.mode !== 'in-process' ||
      r.shard.total !== total ||
      !Number.isInteger(index) ||
      index < 1 ||
      index > total ||
      seen.has(index) ||
      ![0, 1].includes(r.exitCode)
    )
      fail('invalid or duplicate shard')
    seen.add(index)
    const expected = selectShard(specs, r.shard)
    if (
      JSON.stringify(r.selected) !== JSON.stringify(expected) ||
      JSON.stringify(Object.keys(r.results ?? {}).sort()) !== JSON.stringify([...expected].sort())
    )
      fail(`shard ${index} omitted or added specs`)
    for (const checks of Object.values(r.results)) {
      if (
        !Array.isArray(checks) ||
        !checks.length ||
        checks.some((c) => typeof c.name !== 'string' || typeof c.ok !== 'boolean')
      )
        fail(`shard ${index} has no assertions`)
    }
    executed.push(...Object.keys(r.results))
  }
  if (JSON.stringify(executed.sort()) !== JSON.stringify([...specs].sort()))
    fail('spec inventory differs from the complete suite')
  return { complete: true }
}
