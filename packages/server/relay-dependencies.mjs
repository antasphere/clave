/* eslint-disable @typescript-eslint/explicit-function-return-type -- Plain JavaScript, run by Bun and Node. */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

/** Project the relay's runtime closure without resolving or changing a version.
 * The repository's package-lock.json remains the only committed dependency lock. */
export function projectRelayLock(workspaceLock, manifest) {
  if (workspaceLock.lockfileVersion !== 3 || !workspaceLock.packages?.[''])
    throw new Error('Expected the workspace npm v3 lock')
  if (!manifest.dependencies || Object.keys(manifest.dependencies).length === 0)
    throw new Error('The relay must declare its runtime dependencies')
  for (const field of ['devDependencies', 'optionalDependencies', 'peerDependencies', 'workspaces'])
    if (manifest[field]) throw new Error(`Unsupported relay manifest field: ${field}`)

  const source = workspaceLock.packages
  const selected = new Map()
  function resolve(name, from = '') {
    let directory = from
    for (;;) {
      if (path.posix.basename(directory) !== 'node_modules') {
        const key = path.posix.join(directory, 'node_modules', name)
        if (Object.hasOwn(source, key)) return key
      }
      if (!directory) throw new Error(`Missing locked dependency ${name} from ${from || 'relay'}`)
      const parent = path.posix.dirname(directory)
      directory = parent === '.' ? '' : parent
    }
  }
  function visit(key) {
    if (selected.has(key)) return
    const entry = source[key]
    if (
      entry.link ||
      !entry.version ||
      !/^https:\/\/registry\.npmjs\.org\//.test(entry.resolved ?? '') ||
      !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(entry.integrity ?? '')
    )
      throw new Error(`Expected a registry version, URL and SHA-512 integrity for ${key}`)
    if (Object.keys(entry.optionalDependencies ?? {}).length)
      throw new Error(`Optional dependencies need an explicit relay packaging review: ${key}`)
    for (const peer of Object.keys(entry.peerDependencies ?? {}))
      if (!entry.peerDependenciesMeta?.[peer]?.optional)
        throw new Error(`Required peer needs an explicit relay packaging review: ${key} -> ${peer}`)
    // These entries are runtime dependencies here, even if another workspace uses them in dev.
    const runtime = { ...entry }
    delete runtime.dev
    delete runtime.devOptional
    selected.set(key, runtime)
    for (const name of Object.keys(entry.dependencies ?? {}).sort()) visit(resolve(name, key))
  }
  for (const [name, version] of Object.entries(manifest.dependencies).sort()) {
    const key = resolve(name)
    if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version) || source[key].version !== version)
      throw new Error(`Relay ${name}@${version} must match its exact workspace-locked version`)
    visit(key)
  }
  return {
    name: manifest.name,
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: manifest.name, dependencies: manifest.dependencies },
      ...Object.fromEntries([...selected].sort(([a], [b]) => a.localeCompare(b)))
    }
  }
}

export function prepareRelayDependencies(lockPath, manifestPath, outputDirectory) {
  const lockBytes = readFileSync(lockPath)
  const manifestBytes = readFileSync(manifestPath)
  const projected = projectRelayLock(JSON.parse(lockBytes), JSON.parse(manifestBytes))
  const lock = JSON.stringify(projected, null, 2) + '\n'
  mkdirSync(outputDirectory, { recursive: true })
  const outputs = ['package.json', 'package-lock.json', 'relay-dependencies.json']
  for (const name of outputs)
    if (existsSync(path.join(outputDirectory, name)))
      throw new Error(`Refusing to overwrite ${path.join(outputDirectory, name)}`)
  writeFileSync(path.join(outputDirectory, 'package.json'), manifestBytes, { flag: 'wx' })
  writeFileSync(path.join(outputDirectory, 'package-lock.json'), lock, { flag: 'wx' })
  const provenance = {
    workspaceLockSha256: sha256(lockBytes),
    manifestSha256: sha256(manifestBytes),
    projectedLockSha256: sha256(lock),
    packages: Object.entries(projected.packages)
      .filter(([key]) => key)
      .map(([location, entry]) => ({
        location,
        version: entry.version,
        resolved: entry.resolved,
        integrity: entry.integrity
      }))
  }
  writeFileSync(
    path.join(outputDirectory, 'relay-dependencies.json'),
    JSON.stringify(provenance, null, 2) + '\n',
    { flag: 'wx' }
  )
  return provenance
}

export function verifyRelayDependencies(directory) {
  const provenance = JSON.parse(readFileSync(path.join(directory, 'relay-dependencies.json')))
  for (const [name, expected] of [
    ['package.json', provenance.manifestSha256],
    ['package-lock.json', provenance.projectedLockSha256]
  ])
    if (sha256(readFileSync(path.join(directory, name))) !== expected)
      throw new Error(`The frozen install changed ${name}`)
  for (const { location, version } of provenance.packages) {
    const installed = JSON.parse(readFileSync(path.join(directory, location, 'package.json')))
    if (installed.version !== version)
      throw new Error(`Installed ${location}@${installed.version}, expected ${version}`)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.length === 2 && args[0] === '--verify') verifyRelayDependencies(args[1])
  else if (args.length === 3) prepareRelayDependencies(...args)
  else
    throw new Error(
      'Usage: relay-dependencies.mjs <workspace-lock> <relay-manifest> <output> | --verify <output>'
    )
}
