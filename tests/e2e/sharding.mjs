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
  'triage-ui.spec.mjs'
])
export function selectShard(specs, { index, total }) {
  return specs.filter((name, i) => (CLIPBOARD_SPECS.has(name) ? 0 : i % total) === index - 1)
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
