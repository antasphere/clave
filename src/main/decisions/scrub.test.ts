import { describe, expect, it } from 'vitest'
import { clip, scrubHomes, scrubPaths, scrubText } from './scrub'

// What a decision sends is scrubbed and clipped (PRDCT-5179): each rule in
// its order, what no rule may take, and a text that holds them all at once.
// Every path, address, host and token here is invented.

const context = { workspaceRoot: '/Users/ada/w', home: '/Users/ada' }

/** Every printable ASCII character, then the quotes, the arrow and the marks
 *  of prose, and a no-break space: what may stand before a path. */
const BEFORE = [
  ...Array.from({ length: 0x7e - 0x20 + 1 }, (_, i) => String.fromCharCode(0x20 + i)),
  '“',
  '”',
  '‘',
  '’',
  '«',
  '»',
  '→',
  '…',
  '·',
  // A no-break space.
  String.fromCharCode(0xa0)
]
/** What a path never starts after: inside a word, a number or a path. (A
 *  `~` right before a `/` makes a path of its own, in the home folder.) */
const INSIDE = /^[A-Za-z0-9/.-]$/

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
    // The root starts where any path does: after `_` and `@` too.
    expect(scrubText('see _/Users/ada/w/quill/src/ink.ts_ now', context)).toBe(
      'see _quill/src/ink.ts_ now'
    )
    expect(scrubText('Read @/Users/ada/w/quill/src/ink.ts first', context)).toBe(
      'Read @quill/src/ink.ts first'
    )
  })

  it('1. a path is inside the workspace by its normalised form: one that climbs above the root is outside', () => {
    // `..` out of the root reaches a folder of the home, a client's.
    expect(scrubText('see /Users/ada/w/../Clients/AcmeCorp/brief.pdf now', context)).toBe(
      'see <path> now'
    )
    expect(scrubText('cd /Users/ada/w/..', context)).toBe('cd <path>')
    expect(scrubText('cd /Users/ada/w/src/../../Clients, then', context)).toBe('cd <path>, then')
    expect(scrubText('cd ~/w/../Clients/AcmeCorp', context)).toBe('cd <path>')
    expect(scrubText('file:///Users/ada/w/../Clients/AcmeCorp/brief.pdf', context)).toBe('<path>')
    // `.` and a `..` that stays in: inside, relative, resolved.
    expect(
      scrubText('open /Users/ada/w/./src/a.ts and /Users/ada/w/src/../lib/b.ts.', context)
    ).toBe('open src/a.ts and lib/b.ts.')
    expect(scrubText('cd /Users/ada/w/src/.. and /Users/ada/w/../w/atlas', context)).toBe(
      'cd . and atlas'
    )
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

  it('3. a path starts after a mention’s `@`, any quote, `**`, `_`, `!` or `→`', () => {
    expect(scrubText('Compare @/srv/tern/brief.pdf with @quill/src/ink.ts', context)).toBe(
      'Compare @<path> with @quill/src/ink.ts'
    )
    expect(
      scrubText('“~/Clients/Tern/notes.md” and ‘/srv/tern/a’ and «/srv/tern/b»', context)
    ).toBe('“<path> and ‘<path> and «<path>')
    expect(
      scrubText('the **/srv/tern/c** one, _/srv/tern/d_, !/srv/tern/e →/srv/tern/f', context)
    ).toBe('the **<path> one, _<path>, !<path> →<path>')
    // `~name/…` is another account's home: outside, whoever it is.
    expect(scrubText('see ~lumen/notes/todo.md and ~/w/quill/a.ts', context)).toBe(
      'see <path> and quill/a.ts'
    )
    expect(scrubText('_C:\\Clients\\tern.pdf', context)).toBe('_<path>')
  })

  it('3. where a path starts, character by character: anywhere but inside a word, a number or a path', () => {
    expect(BEFORE).toHaveLength(95 + 10)
    for (const c of BEFORE) {
      const text = `see ${c}/srv/tern/x.pdf now`
      const expected = c === '~' ? 'see <path> now' : INSIDE.test(c) ? text : `see ${c}<path> now`
      expect(scrubText(text, context), JSON.stringify(c)).toBe(expected)
    }
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
      './a/b',
      '../a/b',
      'mention @quill/src/ink.ts',
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

  it('6. last, the home folder left becomes <path> with the rest of its path, wherever it stands', () => {
    // After a letter, a digit or a dot, where no path starts, and inside a
    // relative path.
    expect(scrubText('see x/Users/ada/Clients/Tern/brief.pdf now', context)).toBe('see x<path> now')
    expect(scrubText('copied to backup/Users/ada/.config/x.', context)).toBe(
      'copied to backup<path>.'
    )
    expect(scrubText('v2.0/Users/ada/notes', context)).toBe('v2.0<path>')
    // Windows writes a home with `\`, on a drive or not.
    expect(scrubText('see \\Users\\ada\\notes.txt and xC:\\Users\\bob\\a.txt', context)).toBe(
      'see <path> and xC:<path>'
    )
    // The home folder itself wherever it is; a name that only starts like
    // its own is another folder.
    const elsewhere = { workspaceRoot: '/srv/w', home: '/var/lumen' }
    expect(scrubText('logs in x/var/lumen/logs/a.log, not x/var/lumens/b', elsewhere)).toBe(
      'logs in x<path>, not x/var/lumens/b'
    )
  })

  it('6. a folder named home or Users inside a relative path is a folder: it keeps its path', () => {
    expect(scrubText('fix web/home/page.tsx and app/Users/list.tsx', context)).toBe(
      'fix web/home/page.tsx and app/Users/list.tsx'
    )
    // A workspace path made relative, the same.
    expect(
      scrubText('fix /Users/ada/w/web/home/page.tsx and /Users/ada/w/app/Users/list.tsx', context)
    ).toBe('fix web/home/page.tsx and app/Users/list.tsx')
    // The price: another account's home inside a relative path keeps its name.
    expect(scrubText('copied to backup/home/lumen/.config/x.', context)).toBe(
      'copied to backup/home/lumen/.config/x.'
    )
  })

  it('6. another account’s home is taken after anything but a letter, a digit, `.` or `-`', () => {
    for (const form of ['/home/lumen/notes/x.md', '\\Users\\lumen\\notes\\x.md'])
      for (const c of BEFORE) {
        const text = `see ${c}${form} now`
        const kept = /^[A-Za-z0-9.-]$/.test(c)
        expect(scrubHomes(text, context), JSON.stringify([c, form])).toBe(
          kept ? text : `see ${c}<path> now`
        )
      }
  })

  it('6. whatever character stands before a home folder’s path, the name never leaves', () => {
    for (const c of BEFORE) {
      const out = scrubText(`see ${c}/Users/ada/Clients/x.pdf now`, context)
      expect(out, JSON.stringify(c)).not.toContain('ada')
      // Every character but the path's own is kept.
      expect(out, JSON.stringify(c)).toBe(c === '~' ? 'see <path> now' : `see ${c}<path> now`)
    }
  })

  it('sends no `/Users/` and no user name for any text that left whole in round 2', () => {
    const probes: Array<[string, string | null]> = [
      [
        'Open file:///Users/ada/w/quill/dist/index.html in the browser',
        'Open quill/dist/index.html in the browser'
      ],
      ['Open file:///Users/ada/Clients/AcmeCorp/brief.pdf', 'Open <path>'],
      [
        'Saved to /Volumes/Ada Backup/acme-contract.pdf',
        'Saved to <path> Backup/acme-contract.pdf'
      ],
      ['logs in /private/var/folders/xy/T/acme-run/out.log', 'logs in <path>'],
      [
        'see ~/Clients/AcmeCorp/notes.md and /Users/ada/Clients/AcmeCorp/brief.pdf',
        'see <path> and <path>'
      ],
      ['curl http://admin:hunter2pass@localhost:8080/api', 'curl http://localhost:8080/…'],
      ['Open “/Users/ada/Clients/AcmeCorp/brief.pdf” please', 'Open “<path> please'],
      ['Regarde «/Users/ada/Clients/AcmeCorp/brief.pdf»', 'Regarde «<path>'],
      ['The file is **/Users/ada/Clients/AcmeCorp/brief.pdf** now', 'The file is **<path> now'],
      ['Moved it →/Users/ada/Clients/AcmeCorp/brief.pdf', 'Moved it →<path>'],
      [
        'paths: _/Users/ada/Clients/AcmeCorp/x_ and !/Users/ada/Clients/AcmeCorp/y',
        'paths: _<path> and !<path>'
      ],
      ['Use ‘/Users/ada/Clients/AcmeCorp/brief.pdf’', 'Use ‘<path>'],
      [
        'In ~/Clients/AcmeCorp/brief.pdf, and “~/Clients/AcmeCorp/notes.md”',
        'In <path>, and “<path>'
      ],
      // Climbs out of the workspace with `..`: outside, whatever it starts with.
      ['inside /Users/ada/w/../Clients/AcmeCorp/brief.pdf', 'inside <path>'],
      [
        'Compare @/Users/ada/Clients/AcmeCorp/brief.pdf with @quill/src/ink.ts',
        'Compare @<path> with @quill/src/ink.ts'
      ],
      ['Read @/Users/ada/w/quill/src/ink.ts first', 'Read @quill/src/ink.ts first'],
      ['see ~ada/notes/todo.md', 'see <path>']
    ]
    for (const [text, sent] of probes) {
      const out = scrubText(text, context)
      if (sent !== null) expect(out, text).toBe(sent)
      expect(out, text).not.toContain('/Users/')
      expect(out, text).not.toContain('ada')
    }
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
