import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { gzipSync } from 'zlib'
import {
  CLI_OVERRIDE_ENV,
  compareVersions,
  describeState,
  installedVersion,
  installSlideless,
  integrityMatches,
  readTar,
  resolveCli
} from './slideless-cli'

const dirs: string[] = []
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'clave-slideless-'))
  dirs.push(d)
  return d
}
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

/** A ustar archive of the given files, the way npm packs a package. */
function tar(
  files: Record<string, string | Buffer>,
  typeOverride?: Record<string, string>
): Buffer {
  const blocks: Buffer[] = []
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content)
    const header = Buffer.alloc(512)
    header.write(name, 0, 100, 'utf8')
    header.write('0000644\0', 100)
    header.write('0000000\0', 108)
    header.write('0000000\0', 116)
    header.write(data.length.toString(8).padStart(11, '0') + '\0', 124)
    header.write('00000000000\0', 136)
    header.write(typeOverride?.[name] ?? '0', 156)
    header.write('ustar\0', 257)
    header.write('00', 263)
    header.fill(' ', 148, 156)
    let sum = 0
    for (const byte of header) sum += byte
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148)
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  return Buffer.concat(blocks)
}

const integrity = (data: Buffer): string =>
  `sha512-${createHash('sha512').update(data).digest('base64')}`

/** A fetch answering a registry that offers one release of the package. */
function registry(
  version: string,
  tgz: Buffer,
  opts: { integrity?: string } = {}
): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = []
  const fetchImpl = (async (input: string | URL) => {
    const url = String(input)
    calls.push(url)
    if (url.endsWith('/@antasphere%2fslideless/latest'))
      return new Response(
        JSON.stringify({
          version,
          dist: {
            tarball: 'https://registry.test/slideless.tgz',
            integrity: opts.integrity ?? integrity(tgz)
          }
        }),
        { status: 200 }
      )
    if (url === 'https://registry.test/slideless.tgz')
      return new Response(new Uint8Array(tgz), { status: 200 })
    return new Response('nope', { status: 404 })
  }) as typeof fetch
  return { fetch: fetchImpl, calls }
}

const pkg = (version: string, bin = 'console.log("slideless")'): Buffer =>
  gzipSync(
    tar({
      'package/package.json': JSON.stringify({ name: '@antasphere/slideless', version }),
      'package/dist/bin.js': bin,
      'package/LICENSE': 'license'
    })
  )

describe('the managed Slideless CLI', () => {
  it('compares versions as numbers, a pre-release below its release', () => {
    expect(compareVersions('0.14.0', '0.13.14')).toBe(1)
    expect(compareVersions('0.9.0', '0.14.0')).toBe(-1)
    expect(compareVersions('v1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('0.14.0-beta.1', '0.14.0')).toBe(-1)
  })

  it('checks the sha512 integrity, and refuses one that is absent or wrong', () => {
    const data = Buffer.from('bytes')
    expect(integrityMatches(data, integrity(data))).toBe(true)
    expect(integrityMatches(data, integrity(Buffer.from('other')))).toBe(false)
    expect(integrityMatches(data, `sha1-${createHash('sha1').update(data).digest('base64')}`)).toBe(
      false
    )
  })

  it('reads the regular files of an archive and refuses a path that leaves it', () => {
    const files = readTar(tar({ 'package/a.txt': 'A', 'package/dir/b.txt': 'B' }))
    expect(files.get('package/a.txt')?.toString()).toBe('A')
    expect(files.get('package/dir/b.txt')?.toString()).toBe('B')
    expect(() => readTar(tar({ '../escape.txt': 'x' }))).toThrow(/outside the package/)
    expect(() => readTar(tar({ '/etc/passwd': 'x' }))).toThrow(/outside the package/)
    // A symlink entry is skipped, never written.
    expect(readTar(tar({ 'package/link': '' }, { 'package/link': '2' })).size).toBe(0)
  })

  it('installs the latest release from the registry, then runs it', async () => {
    const dir = tmp()
    const reg = registry('0.14.0', pkg('0.14.0', 'console.log("v14")'))
    expect(
      await installSlideless(dir, { fetch: reg.fetch, registry: 'https://registry.test' })
    ).toBe('0.14.0')
    expect(installedVersion(dir)).toBe('0.14.0')
    expect(readFileSync(join(dir, '0.14.0', 'bin.js'), 'utf8')).toBe('console.log("v14")')
    const resolved = resolveCli(dir, {})
    expect(resolved.cli).toEqual({
      cliPath: join(dir, '0.14.0', 'bin.js'),
      version: '0.14.0',
      override: false
    })
    expect(describeState(resolved, false, null)).toEqual({
      phase: 'ready',
      version: '0.14.0',
      error: null,
      override: false
    })
  })

  it('refuses a package whose bytes do not match the published integrity, and keeps the installed one', async () => {
    const dir = tmp()
    await installSlideless(dir, { fetch: registry('0.14.0', pkg('0.14.0')).fetch })
    const tampered = registry('0.15.0', pkg('0.15.0'), {
      integrity: integrity(Buffer.from('else'))
    })
    await expect(installSlideless(dir, { fetch: tampered.fetch })).rejects.toThrow(/integrity/)
    expect(installedVersion(dir)).toBe('0.14.0')
  })

  it('refuses a release older than the one with local versions', async () => {
    const dir = tmp()
    await expect(
      installSlideless(dir, { fetch: registry('0.13.14', pkg('0.13.14')).fetch })
    ).rejects.toThrow(/needs 0.14.0/)
    expect(installedVersion(dir)).toBeNull()
  })

  it('refuses a package that names another version or carries no dist/bin.js', async () => {
    const dir = tmp()
    await expect(
      installSlideless(dir, { fetch: registry('0.14.1', pkg('0.14.0')).fetch })
    ).rejects.toThrow(/says 0.14.0/)
    const noBin = gzipSync(tar({ 'package/package.json': JSON.stringify({ version: '0.14.0' }) }))
    await expect(installSlideless(dir, { fetch: registry('0.14.0', noBin).fetch })).rejects.toThrow(
      /dist\/bin.js/
    )
  })

  it('says why there is no CLI, and takes the override when it names a file', () => {
    const dir = tmp()
    expect(describeState(resolveCli(dir, {}), false, null)).toMatchObject({
      phase: 'missing',
      error: 'Slideless is not installed yet'
    })
    expect(describeState(resolveCli(dir, {}), true, null).phase).toBe('installing')
    expect(describeState(resolveCli(dir, {}), false, 'offline')).toMatchObject({
      phase: 'error',
      error: 'offline'
    })
    const bin = join(dir, 'mine.js')
    writeFileSync(bin, '')
    expect(resolveCli(dir, { [CLI_OVERRIDE_ENV]: bin }).cli).toEqual({
      cliPath: bin,
      version: 'override',
      override: true
    })
    expect(resolveCli(dir, { [CLI_OVERRIDE_ENV]: join(dir, 'nope.js') }).cli).toBeNull()
  })

  it('refuses an installed copy older than the minimum, and a pointer with a strange version', () => {
    const dir = tmp()
    mkdirSync(join(dir, '0.13.14'))
    writeFileSync(join(dir, '0.13.14', 'bin.js'), '')
    writeFileSync(join(dir, 'current.json'), JSON.stringify({ version: '0.13.14' }))
    expect(resolveCli(dir, {})).toMatchObject({
      cli: null,
      reason: expect.stringMatching(/older than/)
    })
    writeFileSync(join(dir, 'current.json'), JSON.stringify({ version: '../../x' }))
    expect(installedVersion(dir)).toBeNull()
  })

  it('gives up on a download that stalls, and keeps the installed copy', async () => {
    const dir = tmp()
    await installSlideless(dir, { fetch: registry('0.14.0', pkg('0.14.0')).fetch })
    const stalled = (async (input: string | URL, init?: RequestInit) => {
      if (String(input).endsWith('/latest'))
        return new Response(
          JSON.stringify({
            version: '0.15.0',
            dist: { tarball: 'https://registry.test/slow.tgz', integrity: 'sha512-x' }
          })
        )
      // Headers arrive, the body never does.
      return new Response(
        new ReadableStream({
          start(controller) {
            init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted')))
          }
        })
      )
    }) as typeof fetch
    await expect(installSlideless(dir, { fetch: stalled, timeoutMs: 200 })).rejects.toThrow(
      /timed out/
    )
    expect(installedVersion(dir)).toBe('0.14.0')
  })
})

describe('the registry read', () => {
  it('gives up on a registry whose answer stalls', async () => {
    const dir = tmp()
    const stalled = (async (_input: string | URL, init?: RequestInit) =>
      new Response(
        new ReadableStream({
          start(controller) {
            init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted')))
          }
        })
      )) as typeof fetch
    await expect(installSlideless(dir, { fetch: stalled, timeoutMs: 200 })).rejects.toThrow(
      /did not answer in time/
    )
  })
})
