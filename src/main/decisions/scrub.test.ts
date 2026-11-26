import { describe, expect, it } from 'vitest'
import { clip, scrubPaths, scrubText } from './scrub'

// What a decision sends is scrubbed and clipped (PRDCT-5179): each rule in
// its order, what no rule may take, and a text that holds them all at once.
// Every path, address, host and token here is invented.

const context = { workspaceRoot: '/Users/ada/w', home: '/Users/ada' }

describe('clip', () => {
  it('collapses whitespace and cuts with a final ellipsis, the ellipsis counted', () => {
    expect(clip('  a\n\n b\tc  ', 10)).toBe('a b c')
    expect(clip('abcdefghij', 10)).toBe('abcdefghij')
    const cut = clip('abcdefghijk', 10)
    expect(cut).toBe('abcdefghi…')
    expect(cut.length).toBe(10)
  })
})

describe('scrubText', () => {
  it('1. makes a path inside the workspace relative to it, the root itself a dot', () => {
    expect(scrubPaths('open /Users/ada/w/labs/quill/src/a.ts now', context)).toBe(
      'open labs/quill/src/a.ts now'
    )
    expect(scrubPaths('cd /Users/ada/w && ls', context)).toBe('cd . && ls')
    expect(scrubPaths('see /Users/ada/w/atlas.', context)).toBe('see atlas.')
    // A `~/…` path is read from the home folder: inside the workspace, relative.
    expect(scrubPaths('cd ~/w/labs/quill please', context)).toBe('cd labs/quill please')
  })

  it('2. a file:// link takes the same rules on its path', () => {
    expect(scrubText('Open file:///Users/ada/w/quill/dist/index.html now', context)).toBe(
      'Open quill/dist/index.html now'
    )
    expect(scrubText('file:///Users/ada/w/my%20notes/a.md#top', context)).toBe('my notes/a.md')
    expect(scrubText('file://localhost/Users/ada/w/atlas/README.md', context)).toBe(
      'atlas/README.md'
    )
    expect(scrubText('Open file:///Users/ada/Clients/Tern/brief.pdf.', context)).toBe(
      'Open <path>.'
    )
    // Another machine's file is outside the workspace whatever its path.
    expect(scrubText('file://lumen-box/Users/ada/w/x.md', context)).toBe('<path>')
  })

  it('3. any other absolute path is dropped, the home folder’s like any other', () => {
    expect(scrubPaths('/Users/ada/notes/todo.md', context)).toBe('<path>')
    expect(scrubPaths('and /Users/ada/Desktop/shot.png,', context)).toBe('and <path>,')
    expect(scrubPaths('/home/lumen/.config/x', context)).toBe('<path>')
    expect(scrubPaths('/Users/bob', context)).toBe('<path>')
    expect(scrubPaths('/opt/tools/bin', context)).toBe('<path>')
    // A folder that only starts like the workspace is outside it.
    expect(scrubPaths('/Users/ada/work/x', context)).toBe('<path>')
    expect(scrubPaths('see ~/Clients/Tern/notes.md', context)).toBe('see <path>')
    // At every boundary: a quote, a bracket, `=`, `:` and a separator.
    expect(
      scrubPaths(
        '"/srv/tern/a" (/srv/tern/b) --out=/srv/tern/c box:/srv/tern/d PATH=/opt/a/bin:/opt/b/bin x;/srv/e/f',
        context
      )
    ).toBe('"<path>" (<path>) --out=<path> box:<path> PATH=<path>:<path> x;<path>')
    // Windows: a drive, a separator and a component.
    expect(scrubPaths('C:\\Users\\ada\\notes.txt and D:/Clients/tern.pdf', context)).toBe(
      '<path> and <path>'
    )
  })

  it('3. a path is cut at a space: what follows the space stays', () => {
    expect(scrubPaths('Saved to /Volumes/Ada Backup/tern-contract.pdf', context)).toBe(
      'Saved to <path> Backup/tern-contract.pdf'
    )
  })

  it('leaves a slash command, a fraction, a date, « and/or » and a plain link as they are', () => {
    for (const text of [
      '/clear',
      '/exos:lane clave 42',
      'run /review then /compact',
      'half of it is 1/2',
      'due on 11/25/2026',
      'tests and/or docs',
      'labs/quill/src/a.ts',
      'see https://atlas.example.com and https://lumen.example/ too.',
      'C:\\ alone'
    ])
      expect(scrubText(text, context)).toBe(text)
  })

  it('4. keeps a link to its scheme and its host, its user and password gone', () => {
    expect(scrubText('see https://atlas.example.com/a/b?c=d#e and', context)).toBe(
      'see https://atlas.example.com/… and'
    )
    expect(scrubText('curl http://admin:hunter2pass@localhost:8080/api', context)).toBe(
      'curl http://localhost:8080/…'
    )
    expect(scrubText('https://ada@lumen.example', context)).toBe('https://lumen.example')
    expect(scrubText('postgres://tern:s3cret@db.internal:5432/app', context)).toBe(
      'postgres://db.internal:5432/…'
    )
    // The path of a link is never taken for the workspace's, nor for a path.
    expect(scrubText('http://lumen.test/Users/ada/w/x', context)).toBe('http://lumen.test/…')
    expect(scrubText('https://lumen.test/x?next=/Users/ada/notes/y', context)).toBe(
      'https://lumen.test/…'
    )
  })

  it('5. replaces a JWT, an e-mail address and a token-like run', () => {
    const jwt = 'eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4'
    expect(scrubText(`bearer ${jwt}`, context)).toBe('bearer <token>')
    expect(scrubText('key sk-quillTESTKEY0123456789', context)).toBe('key <token>')
    expect(scrubText('id ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123 end', context)).toBe('id <token> end')
    // A long folder name inside a path is a path, not a token.
    expect(scrubText('labs/ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123/x', context)).toBe(
      'labs/ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123/x'
    )
    expect(scrubText('write to ada.quill+x@atlas.example.org please', context)).toBe(
      'write to <email> please'
    )
  })

  it('applies every rule to one text, in their order', () => {
    const text = [
      'Fix /Users/ada/w/labs/quill/web/app.ts',
      'and /Users/ada/Desktop/shot.png,',
      'open file:///Users/ada/w/labs/quill/dist/index.html',
      'mail ada@quill.example,',
      'docs https://admin:pw@lumen.example/x/y,',
      'token ghp_abcdefghijklmnop1234',
      'jwt eyJabcdefghij.eyJabcdefghij.abcdefghijkl'
    ].join(' ')
    expect(scrubText(text, context)).toBe(
      'Fix labs/quill/web/app.ts and <path>, open labs/quill/dist/index.html mail <email>, docs https://lumen.example/…, token <token> jwt <token>'
    )
  })
})
