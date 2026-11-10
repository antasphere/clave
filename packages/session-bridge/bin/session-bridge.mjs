#!/usr/bin/env node
// The package ships TypeScript source and no build: Node 22.6+ strips the
// types itself (`--experimental-strip-types`, on by default from Node 23.6),
// and the source stays within the erasable syntax that allows it.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const cli = join(here, '..', 'src', 'cli.ts')
const major = Number(process.versions.node.split('.')[0])
const flags = major >= 23 ? [] : ['--experimental-strip-types', '--no-warnings']
const result = spawnSync(process.execPath, [...flags, cli, ...process.argv.slice(2)], {
  stdio: 'inherit'
})
process.exit(result.status ?? 1)
