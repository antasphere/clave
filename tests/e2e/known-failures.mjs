// The known failures of the end-to-end suite (PRDCT-1711, PRDCT-3154): what
// `tests/e2e/known-failures.json` may say, and how a check's result is read
// against it. Pure, so a plain unit test can exercise it; run.mjs is the only
// caller.
//
//   {
//     "why": "...",
//     "specs": { "<spec file>": ["<check name>", ...] },
//     "unstable": ["<spec file>", ...]
//   }
//
// `specs` names checks that fail on dev deterministically, by spec and by
// check name: a listed check that fails is KNOWN (printed as such, counted
// apart, never a pass), and a listed check that passes is reported so the
// list shrinks. A "<spec> ran to completion" entry is REFUSED there: that
// check is the runner's own, raised when a spec throws, and listing it would
// absorb any crash of that spec, at any line, with exit 0 (the round-1
// verifier proved it). A spec that crashes or flips between runs or machines
// goes under `unstable` instead: every failure in it is UNSTABLE, counted
// apart and printed, and the spec is explicitly, visibly, not a gate until
// it is fixed. Anything else fails the run.

export const RAN_TO_COMPLETION = ' ran to completion'

/** Validate and normalise the file's content. Throws on a shape that would
 *  hide something: a spec listed both ways, a "ran to completion" check. */
export function loadKnown(raw) {
  const out = { why: '', specs: {}, unstable: [] }
  if (raw == null) return out
  if (typeof raw !== 'object') throw new Error('known-failures.json: an object is expected')
  out.why = typeof raw.why === 'string' ? raw.why : ''
  const specs = raw.specs ?? {}
  if (typeof specs !== 'object' || Array.isArray(specs))
    throw new Error('known-failures.json: "specs" must map a spec file to its check names')
  for (const [spec, checks] of Object.entries(specs)) {
    if (!Array.isArray(checks) || checks.some((c) => typeof c !== 'string'))
      throw new Error(`known-failures.json: "specs"."${spec}" must be an array of check names`)
    for (const c of checks) {
      if (c.endsWith(RAN_TO_COMPLETION))
        throw new Error(
          `known-failures.json: "${c}" cannot be a known failure: it is the runner's own check and listing it hides every crash of ${spec}. List the spec under "unstable" instead.`
        )
    }
    out.specs[spec] = [...checks]
  }
  const unstable = raw.unstable ?? []
  if (!Array.isArray(unstable) || unstable.some((s) => typeof s !== 'string'))
    throw new Error('known-failures.json: "unstable" must be an array of spec files')
  for (const spec of unstable) {
    if (spec in out.specs)
      throw new Error(
        `known-failures.json: ${spec} is listed under "specs" and "unstable"; one or the other`
      )
  }
  out.unstable = [...unstable]
  return out
}

/** How one check's result reads: `pass`, `fail`, `known` (listed, failed),
 *  `unstable` (in an unstable spec, failed). `listed` says whether the check
 *  was in `specs`, so a listed pass can be reported. */
export function classify(spec, name, ok, known) {
  const listed = (known.specs[spec] ?? []).includes(name)
  if (ok) return { kind: 'pass', listed }
  if (known.unstable.includes(spec)) return { kind: 'unstable', listed }
  if (listed) return { kind: 'known', listed }
  return { kind: 'fail', listed }
}

/** The run's totals and what to report, from every spec's results. */
export function summarize(results, known) {
  const totals = { passed: 0, failed: 0, known: 0, unstable: 0 }
  const recovered = []
  const unstablePassed = []
  for (const [spec, rows] of Object.entries(results)) {
    let anyFail = false
    for (const r of rows) {
      const c = classify(spec, r.name, r.ok, known)
      totals[c.kind === 'pass' ? 'passed' : c.kind === 'fail' ? 'failed' : c.kind]++
      if (c.kind === 'pass' && c.listed) recovered.push(`${spec}: ${r.name}`)
      if (!r.ok) anyFail = true
    }
    if (known.unstable.includes(spec) && rows.length > 0 && !anyFail) unstablePassed.push(spec)
  }
  return { totals, recovered, unstablePassed, exitCode: totals.failed > 0 ? 1 : 0 }
}
