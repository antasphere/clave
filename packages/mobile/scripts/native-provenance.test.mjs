import { describe, expect, it } from 'vitest'
import { normalizeBundleTransport } from './native-provenance.mjs'

describe('native source comparison transport metadata', () => {
  const url =
    '/node_modules/@shikijs/langs/dist/typescript.bundle?platform=android&transform.bytecode=1&runModule=true'
  const source = `const paths={"42":"${url}"};\nconst ready=true;`
  it('compares the same grammar URL across Hermes and JS transport', () => {
    expect(normalizeBundleTransport(source)).toBe(
      normalizeBundleTransport(source.replace('bytecode=1', 'bytecode=0'))
    )
  })
  it('retains changes to code, grammar, host, port and other query fields', () => {
    for (const changed of [
      source.replace('ready=true', 'ready=false'),
      source.replace('typescript.bundle', 'javascript.bundle'),
      source.replace(url, `http://127.0.0.1:9999${url}`),
      source.replace('platform=android', 'platform=ios'),
      source.replace('runModule=true', 'runModule=false'),
      source.replace('bytecode=1', 'bytecode=2')
    ])
      expect(normalizeBundleTransport(changed)).not.toBe(normalizeBundleTransport(source))
    expect(normalizeBundleTransport('const flag="transform.bytecode=1"')).not.toBe(
      normalizeBundleTransport('const flag="transform.bytecode=0"')
    )
    expect(
      normalizeBundleTransport(
        source.replace('@shikijs/langs', 'some-other-module').replace('bytecode=1', 'bytecode=0')
      )
    ).toContain('bytecode=0')
  })
})
