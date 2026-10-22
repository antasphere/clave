// Independent literal grammar. No parser, React, DOM serializer or source hooks.
export const DEPTHS = Object.freeze([16, 64, 128, 256])
export const STAGES = Object.freeze(['initial', 'append'])
export const ROLES = Object.freeze(['full-a', 'full-b', 'candidate'])

export function demand(condition, message) {
  if (!condition) throw new Error('Deep Markdown contract: ' + message)
}

export function literal(depth, stage) {
  demand(DEPTHS.includes(depth) && STAGES.includes(stage), 'undeclared depth/stage')
  const suffix = stage === 'append' ? ' grows' : ''
  const first = 'a b '.repeat(depth) + 'middle' + ' b a'.repeat(depth)
  return {
    input: '*a **b '.repeat(depth) + 'middle' + ' b** a*'.repeat(depth) + '\n\nMutable' + suffix,
    html:
      '<p>' +
      '<em>a <strong>b '.repeat(depth) +
      'middle' +
      ' b</strong> a</em>'.repeat(depth) +
      '</p>\n<p>Mutable' +
      suffix +
      '</p>',
    text: first + '\nMutable' + suffix,
    paragraphs: [first, 'Mutable' + suffix]
  }
}

export function checkLiteral(row) {
  const expected = literal(row.depth, row.stage)
  for (const field of ['input', 'html', 'text'])
    demand(
      row[field] === expected[field],
      `${row.depth}/${row.stage}/${row.role ?? row.view}: literal ${field}`
    )
  demand(
    JSON.stringify(row.paragraphs) === JSON.stringify(expected.paragraphs),
    'complete ordered paragraphs'
  )
  demand(
    row.em === row.depth && row.strong === row.depth && row.paragraphsCount === 2,
    'complete node counts'
  )
  demand(row.middleOccurrences === 1, 'middle occurs exactly once')
  demand(row.connected === true, 'connected root/article')
  demand(Array.isArray(row.errors) && row.errors.length === 0, 'no renderer errors')
}

export function checkClientRows(rows, cleanup) {
  demand(rows.length === 24, 'all 24 client values')
  let i = 0
  for (const depth of DEPTHS)
    for (const stage of STAGES) {
      const group = []
      for (const role of ROLES) {
        const row = rows[i++]
        demand(row.depth === depth && row.stage === stage && row.role === role, 'client order')
        checkLiteral(row) // Completeness precedes parity, including full/full.
        group.push(row)
      }
      demand(
        group.every((r) => r.html === group[0].html && r.text === group[0].text),
        'full/full/candidate parity'
      )
    }
  demand(
    cleanup.unmountedRoots === 12 && cleanup.rootsUnmounted && cleanup.containersEmpty,
    'all twelve roots unmounted'
  )
  demand(cleanup.errors.length === 0, 'clean React teardown')
}

export function checkNativeRows(rows) {
  demand(rows.length === 16, 'all sixteen native first samples')
  let i = 0
  const sessions = new Set()
  for (const view of ['chat', 'terminal'])
    for (const depth of DEPTHS) {
      let sessionId
      for (const stage of STAGES) {
        const row = rows[i++]
        demand(row.view === view && row.depth === depth && row.stage === stage, 'native order')
        checkLiteral(row)
        demand(typeof row.runId === 'string' && row.runId.length > 0, 'run identity')
        demand(typeof row.sessionId === 'string' && row.sessionId.length > 0, 'session identity')
        demand(row.articleCount === 1 && row.sameArticle === true, 'one retained assistant article')
        demand(
          row.receipt?.kind === 'event' && row.receipt.event?.type === 'assistant_text',
          'canonical public receipt'
        )
        demand(
          row.receipt.event.delta ===
            (stage === 'initial' ? literal(depth, stage).input : ' grows'),
          'exact delivered delta'
        )
        demand(row.receipt.event.final === false, 'unfinished canonical event')
        demand(
          Number.isFinite(row.receivedAt) &&
            Number.isFinite(row.sampledAt) &&
            row.sampledAt - row.receivedAt >= 200,
          'fixed receipt-to-sample settling'
        )
        demand(
          row.animationFrames === 2 && row.sampleCount === 1,
          'one sample after exactly two frames'
        )
        if (stage === 'initial') {
          demand(!sessions.has(row.sessionId), 'fresh unique native session')
          sessionId = row.sessionId
          sessions.add(sessionId)
        } else demand(row.sessionId === sessionId, 'append in same session')
      }
    }
  demand(sessions.size === 8, 'eight fresh native sessions')
}
