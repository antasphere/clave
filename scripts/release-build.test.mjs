/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS test helpers */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

// A server installs a tag with `npm run build` (scripts/install-server.sh),
// which typechecks before it bundles. The macOS release used to package with a
// build of its own that did not: v3.0.0-beta.26 was tagged with a red
// typecheck, the Mac app shipped, and no server could build the tag, so every
// server stayed on the version before while its Mac asked it to upgrade
// (PRDCT-4669). The release now runs the server's build, then packages: a tag
// that a server cannot build is never cut.

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const scripts = JSON.parse(read('package.json')).scripts
const steps = (script) => script.split('&&').map((step) => step.trim())

describe('the release builds what a server builds', () => {
  it('a server installs a tag with npm run build', () => {
    expect(read('scripts/install-server.sh')).toContain('(cd "$staging" && npm run build)')
  })

  it('that build typechecks before it bundles', () => {
    const build = steps(scripts.build)
    expect(build).toContain('npm run typecheck')
    expect(build.indexOf('npm run typecheck')).toBeLessThan(build.indexOf('electron-vite build'))
  })

  it('the macOS release build is that build, then the packaging', () => {
    expect(steps(scripts['build:mac'])).toEqual(['npm run build', 'electron-builder --mac'])
  })

  it('the release script packages through build:mac on both channels, and no other way', () => {
    const commands = read('scripts/release.sh')
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n')
    expect(commands.match(/npm run build:mac/g)).toHaveLength(2)
    expect(commands).not.toMatch(/electron-builder --mac|electron-vite build/)
  })
})
