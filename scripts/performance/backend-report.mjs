#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS, run by node */
// The backend benchmarks' report (lane B of clave-perf-20261015, issue #188):
// reads the result folders `tests/performance/backend-bench.mjs` wrote and
// prints the tables of docs/performance/backend.md, and with `--publish <dir>`
// copies each configuration's raw data, profiles and flamegraphs there.
//
//   node scripts/performance/backend-report.mjs <result dir>... [--publish docs/performance/backend]
//
// It refuses a folder whose run failed, and refuses to publish anything that
// still names a private path: the profiles were scrubbed when the run wrote
// them, and this checks again on the way out.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { gzipSync } from 'node:zlib'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { SampleError, summarize } from './backend-stats.mjs'
import { privatePathsIn } from './backend-profile.mjs'

const ms = (v) =>
  v == null ? '–' : v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)
const pct = (v) => (v == null ? '–' : `${v.toFixed(1)}%`)

/** `median [min–max] (n)` for a handful of values, `p50 / p95 (n)` from 20 on. */
export function cell(name, values, fmt = ms) {
  const s = summarize(name, values)
  return s.p95 == null
    ? `${fmt(s.p50)} [${fmt(s.min)}–${fmt(s.max)}] (n=${s.n})`
    : `${fmt(s.p50)} / ${fmt(s.p95)} (n=${s.n})`
}

export function readRun(dir) {
  const file = path.join(dir, 'raw.json')
  if (!existsSync(file)) throw new SampleError(`${dir}: no raw.json`)
  const run = JSON.parse(readFileSync(file, 'utf-8'))
  if (run.status !== 'ok') throw new SampleError(`${dir}: the run ${run.status ?? 'has no status'}`)
  if (!Array.isArray(run.plain) || run.plain.length === 0)
    throw new SampleError(`${dir}: no plain launch`)
  return { dir, run, key: `${run.config.variant} · ${run.config.scale}` }
}

const STARTUP_ROWS = [
  ['launchResolvedMs', 'Playwright connected to main'],
  ['mainProcessStartMs', 'main process started'],
  ['mainLoopStartMs', 'main event loop running'],
  ['serverProcessStartMs', 'server process started'],
  ['serverLoopStartMs', 'server event loop running'],
  ['shellOnServerMs', 'main registered on its server'],
  ['rendererNavigationStartMs', 'window navigation start'],
  ['domContentLoadedMs', 'window DOMContentLoaded'],
  ['bootCompleteMs', 'window boot complete'],
  ['tabsInGroupsMs', 'every seeded tab in its group']
]

export function startupTable(runs) {
  const head = `| ms after launch | ${runs.map((r) => r.key).join(' | ')} |\n|---|${runs.map(() => '---').join('|')}|`
  const rows = STARTUP_ROWS.map(([k, label]) => {
    const cells = runs.map((r) => {
      const values = r.run.plain.map((l) => l.startup[k]).filter((v) => v != null)
      return values.length === 0 ? '–' : cell(`${r.key} ${k}`, values)
    })
    return `| ${label} | ${cells.join(' | ')} |`
  })
  return [head, ...rows].join('\n')
}

/** Idle: per process, CPU over 1-s intervals pooled across launches, RSS at
 *  the end of the window, and for main and the server the event loop. */
export function idleTable(runs) {
  const lines = [
    '| configuration | process | CPU % of one core, p50 / p95 (1-s intervals) | mean CPU % | RSS MiB (end) | event-loop delay beyond the 10 ms timer, p50 / p99 / max ms (per launch, median) | ELU |',
    '|---|---|---|---|---|---|---|'
  ]
  for (const r of runs) {
    const roles = Object.keys(r.run.plain[0].idle.ps)
    for (const role of roles) {
      const cpu = r.run.plain.flatMap((l) => l.idle.ps[role].raw.cpuPct)
      const rss = r.run.plain.map((l) => l.idle.ps[role].raw.rssMiB.at(-1))
      const mean = cpu.reduce((s, v) => s + v, 0) / cpu.length
      const el = r.run.plain.map((l) => l.idle.eventLoop[role]).filter(Boolean)
      const eld =
        el.length === 0
          ? '–'
          : ['p50', 'p99', 'max']
              .map((q) =>
                ms(
                  summarize(
                    `${r.key} ${role} eld ${q}`,
                    el.map((e) => e.delayMs.excess[q])
                  ).p50
                )
              )
              .join(' / ')
      const elu =
        el.length === 0
          ? '–'
          : role === 'main'
            ? MAIN_ELU
            : pct(
                summarize(
                  `${r.key} ${role} elu`,
                  el.map((e) => e.elu.utilization * 100)
                ).p50
              )
      lines.push(
        `| ${r.key} | ${role} | ${cell(`${r.key} ${role} cpu`, cpu, pct)} | ${pct(mean)} | ${cell(`${r.key} ${role} rss`, rss, (v) => v.toFixed(0))} | ${eld} | ${elu} |`
      )
    }
  }
  return lines.join('\n')
}

/** The seconds right after the boot, before the idle window: the mean CPU
 *  of each process per launch (the restore's tail runs here). */
export function postBootTable(runs) {
  const lines = [
    '| configuration | process | seconds | mean CPU % of one core per launch |',
    '|---|---|---|---|'
  ]
  for (const r of runs) {
    const first = r.run.plain[0].postBoot
    if (!first) continue
    for (const role of Object.keys(first.ps)) {
      const means = r.run.plain.map((l) => {
        const c = l.postBoot.ps[role].cpuPct
        return c.reduce((a, v) => a + v, 0) / c.length
      })
      lines.push(
        `| ${r.key} | ${role} | ${first.seconds} | ${cell(`${r.key} ${role} post-boot`, means, pct)} |`
      )
    }
  }
  return lines.length > 2 ? lines.join('\n') : 'Not recorded by these runs.'
}

/** Electron main runs Chromium's message loop, not libuv's alone, and its
 *  `eventLoopUtilization` reads 0 whatever main does (0.0% in every launch
 *  measured, CPU busy or not), so it is not printed as a figure. */
const MAIN_ELU = 'n/a (Electron loop)'

/** Queries: the cold first call per launch, the warm calls pooled. */
export function queryTable(runs) {
  const lines = [
    '| configuration | method (road) | cold first call ms | warm p50 / p95 ms | answer bytes |',
    '|---|---|---|---|---|'
  ]
  for (const r of runs) {
    for (const [method, q] of Object.entries(r.run.plain[0].queries.methods)) {
      const cold = r.run.plain.map((l) => l.queries.methods[method].coldMs)
      const warm = r.run.plain.flatMap((l) => l.queries.methods[method].raw)
      lines.push(
        `| ${r.key} | ${method} (${q.road}) | ${cell(`${r.key} ${method} cold`, cold)} | ${cell(`${r.key} ${method} warm`, warm)} | ${q.answerBytes} |`
      )
    }
  }
  return lines.join('\n')
}

/** Main and the server over the query pass: the event loop and the CPU. */
export function queryLoadTable(runs) {
  const lines = [
    '| configuration | process | pass s | CPU % of one core over the pass | event-loop delay beyond the 10 ms timer, p99 / max ms | ELU |',
    '|---|---|---|---|---|---|'
  ]
  for (const r of runs) {
    for (const role of Object.keys(r.run.plain[0].queries.eventLoop)) {
      const e = r.run.plain.map((l) => l.queries.eventLoop[role])
      const cpu = e.map((x) => ((x.cpuUserUs + x.cpuSystemUs) / 1000 / x.wallMs) * 100)
      lines.push(
        `| ${r.key} | ${role} | ${cell(
          `${r.key} pass`,
          r.run.plain.map((l) => l.queries.passMs / 1000),
          (v) => v.toFixed(1)
        )} | ${cell(`${r.key} ${role} pass cpu`, cpu, pct)} | ${cell(
          `${r.key} ${role} p99`,
          e.map((x) => x.delayMs.excess.p99)
        )} / ${cell(
          `${r.key} ${role} max`,
          e.map((x) => x.delayMs.excess.max)
        )} | ${
          role === 'main'
            ? MAIN_ELU
            : cell(
                `${r.key} ${role} elu`,
                e.map((x) => x.elu.utilization * 100),
                pct
              )
        } |`
      )
    }
  }
  return lines.join('\n')
}

/** The profilers' cost: plain against profiled startup. */
export function overheadTable(runs) {
  const lines = [
    '| configuration | boot complete, plain | boot complete, profiled |',
    '|---|---|---|'
  ]
  for (const r of runs) {
    if (!r.run.profiled?.length) continue
    lines.push(
      `| ${r.key} | ${cell(
        'plain',
        r.run.plain.map((l) => l.startup.bootCompleteMs)
      )} | ${cell(
        'profiled',
        r.run.profiled.map((l) => l.startup.bootCompleteMs)
      )} |`
    )
  }
  return lines.join('\n')
}

/** Every profile: its busy share, the heaviest self-time frames, and the
 *  app's own frames by total time. Shares are of the BUSY time (everything
 *  but `(idle)`), so a mostly idle window still shows where its work went. */
export function profileTables(runs, top = 12) {
  const out = []
  const esc = (label) => '`' + label.replace(/\|/g, '\\|') + '`'
  for (const r of runs) {
    const startup = r.run.startupProfile?.profiles ? [r.run.startupProfile] : []
    for (const launch of [...(r.run.profiled ?? []), ...startup]) {
      for (const [name, p] of Object.entries(launch.profiles ?? {})) {
        const b = p.breakdown
        const share = (us) => (b.busyUs > 0 ? ((us / b.busyUs) * 100).toFixed(1) : '–')
        const self = p.top
          .filter((row) => row.label !== '(idle)')
          .slice(0, top)
          .map(
            (row) =>
              `| ${(row.selfUs / 1000).toFixed(1)} | ${share(row.selfUs)} | ${esc(row.label)} |`
          )
        const app = (p.app ?? [])
          .slice(0, top)
          .map(
            (row) =>
              `| ${(row.totalUs / 1000).toFixed(1)} | ${share(row.totalUs)} | ${(row.selfUs / 1000).toFixed(1)} | ${esc(row.label)} |`
          )
        out.push(
          `#### ${r.key} · ${name}\n\n` +
            `${(p.sampledMs / 1000).toFixed(1)} s sampled (${p.samples} samples, ${p.reordered ?? 0} out of order): ` +
            `busy ${(b.busyUs / 1000).toFixed(0)} ms = ${((b.busyUs / b.totalUs) * 100).toFixed(1)}% ` +
            `(JS ${share(b.js)}%, native ${share(b.program)}%, GC ${share(b.gc)}% of busy). ` +
            `Flamegraph: \`${p.files.flamegraph}\`.\n\n` +
            'Heaviest frames by self time:\n\n| self ms | % of busy | frame |\n|---|---|---|\n' +
            self.join('\n') +
            (app.length > 0
              ? '\n\nClave code by total time:\n\n| total ms | % of busy | self ms | frame |\n|---|---|---|---|\n' +
                app.join('\n')
              : '\n\nNo Clave frame was sampled in this window.')
        )
      }
    }
  }
  return out.join('\n\n')
}

export function identityTable(runs) {
  const lines = [
    '| configuration | build | machine | co-running load at each launch (1-min loadavg / other processes CPU %) |',
    '|---|---|---|---|'
  ]
  for (const r of runs) {
    const b = r.run.build
    const build =
      b.kind === 'installed'
        ? `installed ${b.version}, Electron ${b.electronFramework}`
        : `dev ${b.sha.slice(0, 8)} (tree ${b.tree.slice(0, 8)}${b.trackedChanges ? ', tracked changes' : ''}), Electron ${b.electron}`
    const m = r.run.machine
    const machine = `${m.cpuModel}, ${m.logicalCores} cores, ${m.memoryGiB} GiB, macOS ${m.macos}`
    const load = [...r.run.plain, ...(r.run.profiled ?? [])]
      .map((l) => `${l.load.loadavg1m.toFixed(1)}/${l.load.otherProcessesCpuPct.toFixed(0)}`)
      .join(', ')
    lines.push(`| ${r.key} | ${build} | ${machine} | ${load} |`)
  }
  return lines.join('\n')
}

/** Copy one configuration's raw data, flamegraphs and profiles under
 *  `dest`, refusing every file when one still names a private path. The
 *  profiles go gzipped (`.cpuprofile.gz`: `gunzip`, then DevTools'
 *  Performance panel or speedscope opens them); the folded stacks stay with
 *  the local results, since each is rebuilt from its profile and together
 *  they weigh more than everything else. */
export function publish(r, dest) {
  const name = path.basename(r.dir)
  const target = path.join(dest, name)
  const roots = [[os.homedir(), '~']]
  const files = readdirSync(r.dir).filter(
    (f) => f === 'raw.json' || /\.(cpuprofile|flame\.html)$/.test(f)
  )
  const bodies = new Map()
  for (const f of files) {
    const body = readFileSync(path.join(r.dir, f), 'utf-8')
    const leaks = privatePathsIn(body, roots)
    if (leaks.length > 0)
      throw new SampleError(`${name}/${f} names a private path: ${leaks.slice(0, 3).join(', ')}`)
    bodies.set(f, body)
  }
  mkdirSync(target, { recursive: true })
  for (const [f, body] of bodies) {
    if (f.endsWith('.cpuprofile'))
      writeFileSync(path.join(target, `${f}.gz`), gzipSync(body, { level: 9 }))
    else writeFileSync(path.join(target, f), body)
  }
  return { name, files: bodies.size }
}

export function main(argv = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { publish: { type: 'string' } },
    allowPositionals: true
  })
  if (positionals.length === 0) throw new Error('give one or more result folders')
  const runs = positionals.map((d) => readRun(path.resolve(d)))
  const sections = [
    ['Build, machine and co-running load', identityTable(runs)],
    ['Startup', startupTable(runs)],
    ['Right after the boot', postBootTable(runs)],
    ['Idle', idleTable(runs)],
    ['Query latency from the window', queryTable(runs)],
    ['Main and server during the query pass', queryLoadTable(runs)],
    ['Profiler overhead', overheadTable(runs)],
    ['Where the CPU goes', profileTables(runs)]
  ]
  const md = sections.map(([h, body]) => `### ${h}\n\n${body}`).join('\n\n') + '\n'
  if (values.publish) {
    const dest = path.resolve(values.publish)
    for (const r of runs) publish(r, dest)
    const leaks = privatePathsIn(md, [[os.homedir(), '~']])
    if (leaks.length > 0) throw new SampleError(`the tables name a private path: ${leaks[0]}`)
    writeFileSync(path.join(dest, 'tables.md'), md)
  }
  process.stdout.write(md)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main()
  } catch (err) {
    process.stderr.write(`[backend-report] FAILED: ${err?.stack ?? err}\n`)
    process.exit(1)
  }
}
