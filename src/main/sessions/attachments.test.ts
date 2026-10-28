import { afterEach, expect, test } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareAttachment, preparePrompt } from './attachments'

const directories: string[] = []
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAGUlEQVR4nGPwrn32nxLMMGrAqAGjBgwXAwB7Aq0fO8+5wwAAAABJRU5ErkJggg==',
  'base64'
)
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})
async function setup(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'clave-attachments-'))
  directories.push(dir)
  return dir
}

test('copies a pasted image durably and encodes the actual bytes for the provider', async () => {
  const directory = await setup()
  const file = await prepareAttachment(directory, { name: 'Screenshot.png', bytes: png })
  expect(file).toMatchObject({ name: 'Screenshot.png', mimeType: 'image/png', delivery: 'image' })
  expect(await readFile(file.path)).toEqual(png)
  const prompt = await preparePrompt('', [file], true)
  expect(prompt).toEqual({
    text: '',
    images: [{ name: file.name, mimeType: 'image/png', data: png.toString('base64') }]
  })
  // An adapter without image content never gets the bytes; the reader must
  // choose the reference explicitly.
  await expect(preparePrompt('', [file], false)).rejects.toThrow('Send as file reference')
  const reference = await preparePrompt('look', [{ ...file, delivery: 'reference' }], false)
  expect(reference.images).toEqual([])
  expect(reference.text).toContain('look\n\nAttachments, by the marker')
  expect(reference.text).toContain(JSON.stringify({ name: file.name, path: file.path }))
})
test('names a pasted image by its bytes, not by what the clipboard called it', async () => {
  const directory = await setup()
  const file = await prepareAttachment(directory, { name: 'photo.jpg', bytes: png })
  expect(file.name).toBe('photo.png')
  expect(file.mimeType).toBe('image/png')
})
test('rejects missing files, directories and image bytes disguised by their name', async () => {
  const directory = await setup()
  await expect(prepareAttachment(directory, { path: directory })).rejects.toThrow('Folders')
  await expect(
    prepareAttachment(directory, { name: 'bad.png', bytes: Buffer.from('not an image') })
  ).rejects.toThrow('Only PNG')
  await expect(prepareAttachment(directory, { path: 'relative.txt' })).rejects.toThrow('local file')
  const path = join(directory, 'fake.png')
  await writeFile(path, 'not an image')
  const file = await prepareAttachment(join(directory, 'saved'), { path })
  await expect(preparePrompt('', [file], true)).rejects.toThrow('do not match')
  await rm(file.path)
  await expect(preparePrompt('', [file], true)).rejects.toThrow('unavailable')
})
test('copies temporary drops so deleting their source does not break the attachment', async () => {
  const directory = await setup()
  const path = join(directory, 'Screenshot.png')
  await writeFile(path, png)
  const file = await prepareAttachment(join(directory, 'saved'), { path })
  expect(file.path).not.toBe(path)
  await rm(path)
  expect((await preparePrompt('inspect', [file], true)).images).toHaveLength(1)
})
test('rejects too many files, excessive image bytes and invalid paths', async () => {
  const directory = await setup()
  const file = await prepareAttachment(directory, { name: 'image.png', bytes: png })
  await expect(preparePrompt('', Array(11).fill(file), true)).rejects.toThrow()
  await expect(preparePrompt('', [{ ...file, path: 'relative' }], true)).rejects.toThrow('absolute')
  await writeFile(file.path, Buffer.alloc(5 * 1024 * 1024 + 1))
  await expect(preparePrompt('', [file], true)).rejects.toThrow('5 MiB')
})
test('ordinary references keep the original path and never embed contents', async () => {
  // A directory inside the repository is stable; the OS temp roots are the
  // ones deliberately copied, so this test must not live there.
  const directory = await mkdtemp(join(process.cwd(), '.attachments-unit-'))
  directories.push(directory)
  const path = join(directory, 'index.ts')
  await writeFile(path, 'original')
  await mkdir(join(directory, 'saved'))
  const file = await prepareAttachment(join(directory, 'saved'), { path })
  expect(file).toMatchObject({ path, mimeType: 'application/octet-stream', delivery: 'reference' })
  await writeFile(path, 'updated')
  const prompt = await preparePrompt('read this', [file], false)
  expect(prompt.text).toContain(JSON.stringify(path))
  expect(prompt.text).not.toContain('original')
  expect(prompt.text).not.toContain('updated')
  expect(prompt.images).toEqual([])
})

test('accepts exactly 20 MiB and rejects 20 MiB plus one byte and five valid 5 MiB images', async () => {
  const directory = await setup()
  const large = Buffer.alloc(5 * 1024 * 1024)
  png.copy(large)
  const path = join(directory, 'large.png')
  await writeFile(path, large)
  const file = await prepareAttachment(join(directory, 'saved'), { path })
  const nearlyFullPath = join(directory, 'nearly-full.png')
  await writeFile(nearlyFullPath, large.subarray(0, large.length - 7))
  const nearlyFull = await prepareAttachment(join(directory, 'saved'), { path: nearlyFullPath })
  const tinyPath = join(directory, 'tiny.png')
  await writeFile(tinyPath, png.subarray(0, 8))
  const tiny = await prepareAttachment(join(directory, 'saved'), { path: tinyPath })
  expect((await preparePrompt('', Array(4).fill(file), true)).images).toHaveLength(4)
  const refuses = async (input: unknown): Promise<void> => {
    const accepted = await preparePrompt('', input, true).then(
      () => true,
      (error: unknown) => {
        expect(String(error)).toContain('20 MiB')
        return false
      }
    )
    expect(accepted).toBe(false)
  }
  await refuses([file, file, file, nearlyFull, tiny])
  await refuses(Array(5).fill(file))
})

test('an image no provider takes as content is a file from the start: the agent gets its path', async () => {
  const directory = await setup()
  const heic = join(directory, 'photo.heic')
  await writeFile(heic, Buffer.from('not really a heic'))
  const file = await prepareAttachment(directory, { path: heic })
  expect(file).toMatchObject({ mimeType: 'image/heic', delivery: 'reference' })
  const prompt = await preparePrompt('see', [{ ...file, label: 'File #1' }], true)
  expect(prompt.images).toEqual([])
  expect(prompt.text).toContain(
    '[File #1] ' + JSON.stringify({ name: 'photo.heic', path: file.path })
  )
  // The SVG and AVIF cases follow the same rule.
  const svg = join(directory, 'mark.svg')
  await writeFile(svg, '<svg/>')
  expect((await prepareAttachment(directory, { path: svg })).delivery).toBe('reference')
})
test('markers key every line the provider reads, sessions included', async () => {
  const directory = await setup()
  const shot = await prepareAttachment(directory, { name: 'shot.png', bytes: png })
  const notes = join(directory, 'notes.txt')
  await writeFile(notes, 'n')
  const file = await prepareAttachment(directory, { path: notes })
  const prompt = await preparePrompt(
    'finish when [Session #1] is done, see [Image #1] and [File #1]',
    [
      { ...shot, label: 'Image #1' },
      { ...file, label: 'File #1' },
      {
        id: 's',
        label: 'Session #1',
        delivery: 'session',
        sessionId: 'lane-a',
        name: 'Lane A',
        agent: 'Claude Code',
        cwd: '/work/a'
      }
    ],
    true
  )
  expect(prompt.images).toHaveLength(1)
  const lines = prompt.text.split('\n')
  expect(lines[0]).toBe('finish when [Session #1] is done, see [Image #1] and [File #1]')
  expect(lines).toContain('- an image: sent with this message as image content.')
  expect(lines).toContain('- a local file: read the current contents at its path.')
  expect(
    lines.some((l) => l.startsWith('- a Clave session') && l.includes('clave_read_session'))
  ).toBe(true)
  expect(lines).toContain('[Image #1] ' + JSON.stringify({ image: 'shot.png' }))
  expect(lines).toContain('[File #1] ' + JSON.stringify({ name: 'notes.txt', path: file.path }))
  expect(lines).toContain(
    '[Session #1] ' +
      JSON.stringify({ session: 'lane-a', name: 'Lane A', agent: 'Claude Code', cwd: '/work/a' })
  )
  // A session needs no file on disk; a session id that is not one is refused.
  await expect(
    preparePrompt(
      'x',
      [{ id: 's', delivery: 'session', sessionId: '../x', name: 'n', agent: 'a', cwd: '' }],
      true
    )
  ).rejects.toThrow()
})
