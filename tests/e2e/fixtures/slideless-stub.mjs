// A Slideless command line for the end-to-end specs (PRDCT-4266), run by the
// app's server in place of its own copy through CLAVE_SLIDELESS_CLI: as
// `<node> <stub> …` for the accounts and the links, as `<node> <host> <stub>
// dev …` for a preview (the host takes itself out of argv first, so the
// arguments start at argv[2] either way).
//
// Its world is the JSON file named by SLIDELESS_STUB_STATE: the listing's
// machine, logins and profiles (each with a `stub` part the listing never
// shows: what a check learns, what it answers, whether failures on that site
// open with the command's « older than its site » notice), the sites
// `profiles add` knows, the e-mail codes each site accepts, the keys it
// refuses (by sha256, never in the clear), the decks and their links. A call
// that changes the world writes it back through a rename.
//
// Every call appends ONE line to the file named by SLIDELESS_STUB_JOURNAL:
// `{ argv, stdin, stdinSha256 }`, the input's byte length and its hash when
// the call read one, null otherwise: never the input itself, so a spec can
// prove a code, a key or a password went on the input and nowhere else.
//
// `dev`, `snapshot` and `snapshots` are the real command's (the package
// Clave keeps as a dev dependency, or SLIDELESS_E2E_CLI), imported, so the
// preview works. Any other verb this file does not know exits 2.
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const argv = process.argv.slice(2)
const STATE = process.env.SLIDELESS_STUB_STATE
const JOURNAL = process.env.SLIDELESS_STUB_JOURNAL
const REAL_CLI =
  process.env.SLIDELESS_E2E_CLI ||
  fileURLToPath(new URL('../../../node_modules/@antasphere/slideless/dist/bin.js', import.meta.url))
const CLI_VERSION = '0.15.0'

const sha256 = (text) => createHash('sha256').update(text).digest('hex')

/** A site's origin in one form (the server's own `normalOrigin`). */
function normalOrigin(value) {
  const text = String(value ?? '').trim()
  try {
    const url = new URL(text)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return text.replace(/\/+$/, '')
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`
  } catch {
    return text.replace(/\/+$/, '')
  }
}

// ── The journal: one line per call, the input's length and hash, never its value ──

let journaled = false
function journal(input = null) {
  if (journaled || !JOURNAL) return
  journaled = true
  appendFileSync(
    JOURNAL,
    `${JSON.stringify({
      argv,
      stdin: input === null ? null : Buffer.byteLength(input),
      stdinSha256: input === null ? null : sha256(input)
    })}\n`
  )
}

// ── Ending: every stream flushed before the process goes ──

function end(code) {
  journal()
  // The code stands even if the loop drains before the flushes are told.
  process.exitCode = code
  process.stdout.write('', () => process.stderr.write('', () => process.exit(code)))
}
function answer(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
  end(0)
}

// ── The world ──

function load() {
  if (!STATE || !existsSync(STATE)) throw new Error('SLIDELESS_STUB_STATE names no file')
  return JSON.parse(readFileSync(STATE, 'utf8'))
}
function save(world) {
  const staging = `${STATE}.${process.pid}.tmp`
  writeFileSync(staging, `${JSON.stringify(world, null, 2)}\n`)
  renameSync(staging, STATE)
}
const profileAt = (world, origin) =>
  world.profiles.find((p) => normalOrigin(p.site.origin) === normalOrigin(origin))

/** A failure as the command says one: the notice first on a site newer than it, then `Error:`. */
function fail(world, site, sentence, code = 1) {
  const profile = site ? profileAt(world, site) : undefined
  if (profile?.stub?.notice)
    process.stderr.write(
      `This slideless (${CLI_VERSION}) is older than ${normalOrigin(site)} (${profile.site.cliVersion}).\n`
    )
  process.stderr.write(`Error: ${sentence}\n`)
  end(code)
}

/** A profile as the listing shows it: its `stub` part left out, and what a check answers when it ran. */
function shown(profile, checked) {
  const { stub, ...rest } = profile
  if (!checked) return rest
  const check = stub?.check ?? {
    checked: profile.signIn.state === 'signed_in' ? 'ok' : 'no_key',
    person: null
  }
  return {
    ...rest,
    signIn: { ...rest.signIn, checked: check.checked, person: check.person ?? null }
  }
}

// ── The input ──

/** One line of the input, its end of line included (the code a sign-in answers). */
function readLine() {
  return new Promise((resolve) => {
    let text = ''
    const done = () => {
      process.stdin.off('data', onData)
      process.stdin.off('end', done)
      process.stdin.pause()
      resolve(text)
    }
    const onData = (chunk) => {
      text += chunk.toString('utf8')
      const cut = text.indexOf('\n')
      if (cut >= 0) {
        text = text.slice(0, cut + 1)
        done()
      }
    }
    process.stdin.on('data', onData)
    process.stdin.on('end', done)
    process.stdin.resume()
  })
}

/** The whole input, to its end (a key, a password). */
function readAll() {
  return new Promise((resolve) => {
    let text = ''
    process.stdin.on('data', (chunk) => {
      text += chunk.toString('utf8')
    })
    process.stdin.on('end', () => resolve(text))
    process.stdin.resume()
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── The arguments: the global options anywhere, the verb, the rest ──

function parse(args) {
  let apiUrl = null
  let profile = null
  let verb = null
  const rest = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--api-url') apiUrl = args[++i] ?? null
    else if (arg.startsWith('--api-url=')) apiUrl = arg.slice('--api-url='.length)
    else if (arg === '--profile') profile = args[++i] ?? null
    else if (arg === '--json') continue
    else if (verb === null && !arg.startsWith('-')) verb = arg
    else rest.push(arg)
  }
  return { apiUrl, profile, verb, rest }
}
const option = (rest, name) => {
  const at = rest.indexOf(name)
  return at >= 0 ? (rest[at + 1] ?? null) : null
}
const flag = (rest, name) => rest.includes(name)
/** The first argument that is neither an option nor an option's value. */
function operand(rest, valued) {
  for (let i = 0; i < rest.length; i++) {
    if (valued.includes(rest[i])) i++
    else if (!rest[i].startsWith('-')) return rest[i]
  }
  return null
}

/** The site a call reaches: the last `--api-url`, else the `--profile`'s, else the default. */
function siteOf(world, { apiUrl, profile }) {
  if (apiUrl) return normalOrigin(apiUrl)
  if (profile) {
    const named = world.profiles.find((p) => p.name === profile)
    if (named) return normalOrigin(named.site.origin)
  }
  return normalOrigin(world.defaultSite ?? '')
}

// ── The verbs ──

async function profiles(world, call) {
  const [sub, ...args] = call.rest
  if (sub === undefined || sub === '--check') {
    const check = sub === '--check' || args.includes('--check')
    if (check) {
      // What the sites say of themselves is kept, as the command keeps a site it read.
      let learned = false
      for (const profile of world.profiles) {
        const learn = profile.stub?.learn
        if (!learn) continue
        profile.site = { ...profile.site, ...learn.site }
        profile.signIn = { ...profile.signIn, ...learn.signIn }
        if ('cliBehind' in learn) profile.cliBehind = learn.cliBehind
        delete profile.stub.learn
        learned = true
      }
      if (learned) save(world)
      if (world.checkDelayMs) await sleep(world.checkDelayMs)
    }
    return answer({
      machine: world.machine,
      cliVersion: CLI_VERSION,
      defaultSite: world.defaultSite ?? null,
      environment: world.environment ?? { url: null, key: false, hubUrl: null },
      logins: world.logins ?? [],
      profiles: world.profiles.map((profile) => shown(profile, check))
    })
  }
  if (sub === 'add') {
    const url = args.find((arg) => !arg.startsWith('-'))
    const origin = normalOrigin(url ?? '')
    if (!url) return fail(world, null, 'Name the site to add: slideless profiles add <url>.')
    const there = profileAt(world, origin)
    if (there)
      return fail(world, null, `${origin} is already a site of this machine (${there.name}).`)
    const known = world.addable?.[origin]
    const host = (() => {
      try {
        return new URL(origin).host
      } catch {
        return origin
      }
    })()
    const profile = {
      name: known?.name ?? host.replace(/[^A-Za-z0-9]+/g, '-'),
      default: false,
      saved: true,
      site: {
        origin,
        name: null,
        hub: null,
        federated: null,
        cliVersion: null,
        seenAt: null,
        ...known?.site
      },
      cliBehind: known?.cliBehind ?? null,
      signIn: {
        state: 'unknown',
        via: null,
        hub: null,
        email: null,
        staleKeys: 0,
        fix: { kind: 'check', argv: ['slideless', 'profiles', '--check'] },
        ...known?.signIn
      },
      environment: known?.environment ?? [],
      stub: known?.stub ?? {}
    }
    world.profiles.push(profile)
    save(world)
    // ONE profile entry, as the command answers an add.
    return answer(shown(profile, false))
  }
  if (sub === 'remove') {
    const name = args.find((arg) => !arg.startsWith('-'))
    const at = world.profiles.findIndex((p) => p.name === name)
    if (at < 0) return fail(world, null, `No profile named ${name}.`)
    world.profiles.splice(at, 1)
    save(world)
    return answer({ removed: name })
  }
  return fail(world, null, `Unknown profiles command: ${sub}`, 2)
}

async function login(world, call) {
  const site = siteOf(world, call)
  const profile = profileAt(world, site)
  if (flag(call.rest, '--api-key-stdin')) {
    const input = await readAll()
    journal(input)
    if (!profile) return fail(world, null, `${site} is not a site of this machine.`)
    const key = input.replace(/\r?\n$/, '')
    if (key === '') return fail(world, site, 'No key on the input.')
    if ((world.refusedKeys ?? []).includes(sha256(key)))
      return fail(world, site, 'The site refused this key.')
    const email = world.keyEmail ?? null
    profile.signIn = {
      ...profile.signIn,
      state: 'signed_in',
      via: 'key',
      hub: null,
      email,
      staleKeys: 0,
      fix: null
    }
    profile.stub = {
      ...profile.stub,
      check: {
        checked: 'ok',
        person: email ? { name: null, email, workspace: null } : null
      }
    }
    save(world)
    return answer({ site, via: 'key' })
  }
  if (!profile) {
    journal()
    return fail(world, null, `${site} is not a site of this machine.`)
  }
  // The e-mail code: the address given, else the login's at the hub named, else none (asked).
  const hub = option(call.rest, '--hub')
  let email =
    option(call.rest, '--email') ??
    (hub
      ? ((world.logins ?? []).find((l) => normalOrigin(l.hub) === normalOrigin(hub))?.email ?? null)
      : null)
  if (profile.stub?.notice)
    process.stderr.write(
      `This slideless (${CLI_VERSION}) is older than ${site} (${profile.site.cliVersion}).\n`
    )
  if (!email) {
    process.stderr.write('Email: ')
    email = (await readLine()).trim()
  }
  process.stderr.write(`A sign-in code was sent to ${email} …\n`)
  process.stderr.write('Code: ')
  const line = await readLine()
  journal(line)
  const code = line.replace(/\r?\n$/, '')
  if (code !== world.codes?.[site]) {
    process.stderr.write(`Error: That code is not the one that was sent.\n`)
    return end(1)
  }
  const through = hub ? normalOrigin(hub) : profile.site.hub
  profile.signIn = {
    ...profile.signIn,
    state: 'signed_in',
    via: through ? 'login' : 'key',
    hub: through ?? null,
    email,
    staleKeys: 0,
    fix: null
  }
  profile.stub = {
    ...profile.stub,
    check: { checked: 'ok', person: { name: null, email, workspace: null } }
  }
  if (through && !(world.logins ?? []).some((l) => normalOrigin(l.hub) === through))
    world.logins = [...(world.logins ?? []), { hub: through, email, name: new URL(through).host }]
  save(world)
  return answer({ site, email })
}

/** A site the command may push to: one of the machine's, signed in. */
function signedIn(world, site) {
  const profile = profileAt(world, site)
  if (!profile) return `${site} is not a site of this machine.`
  if (!['signed_in', 'will_sign_in'].includes(profile.signIn.state))
    return `Not signed in to ${site}: run slideless login.`
  return null
}

function push(world, call) {
  const site = siteOf(world, call)
  const target = operand(call.rest, ['--title', '--id', '--entry', '--kind'])
  if (!target || !existsSync(target)) return fail(world, site, `No such file or folder: ${target}`)
  const refused = signedIn(world, site)
  if (refused) return fail(world, site, refused)
  const title = option(call.rest, '--title') ?? path.basename(target)
  const id = option(call.rest, '--id')
  let deckId
  if (id !== null) {
    const deck = world.decks[id]
    if (!deck || deck.gone || normalOrigin(deck.site) !== site)
      return fail(world, site, `not_found: ${site} has no deck ${id}.`)
    deck.version += 1
    deck.title = title
    deckId = id
  } else {
    deckId = `deck-${world.nextDeck++}`
    world.decks[deckId] = { site, title, version: 1, tokens: [], gone: false }
  }
  // The link file, where the command writes it: in the folder pushed, or beside the file.
  const folder = statSync(target).isDirectory() ? target : path.dirname(target)
  writeFileSync(
    path.join(folder, '.slideless.json'),
    `${JSON.stringify({ presentationId: deckId, baseUrl: site }, null, 2)}\n`
  )
  save(world)
  const deck = world.decks[deckId]
  return answer({
    presentation: { id: deckId, title },
    version: { version: deck.version },
    url: `${site}/d/${deckId}`,
    attachments: []
  })
}

async function share(world, call) {
  const site = siteOf(world, call)
  let password = null
  if (flag(call.rest, '--password-stdin')) {
    const input = await readAll()
    journal(input)
    password = input.replace(/\r?\n$/, '')
  }
  const deckId = operand(call.rest, ['--name', '--expires', '--to-version', '--password'])
  const deck = deckId ? world.decks[deckId] : undefined
  if (!deck || deck.gone || normalOrigin(deck.site) !== site)
    return fail(world, site, `not_found: ${site} has no deck ${deckId}.`)
  if (password !== null && password.length < 4)
    return fail(world, site, 'A password is at least 4 characters long.')
  const token = `tok-${world.nextToken++}`
  deck.tokens.push(token)
  save(world)
  return answer({
    url: `https://${new URL(site).host}/s/${token}`,
    shareToken: { id: token, name: option(call.rest, '--name') ?? 'Link', hasPassword: !!password }
  })
}

function unshare(world, call) {
  const site = siteOf(world, call)
  const token = option(call.rest, '--token')
  // With no token the real command revokes EVERY link of the deck: refused here, so a call that forgets it fails.
  if (!token)
    return fail(world, site, 'unshare without --token revokes every link: refused by the stub.')
  const deckId = operand(call.rest, ['--token'])
  const deck = deckId ? world.decks[deckId] : undefined
  if (!deck || normalOrigin(deck.site) !== site || !deck.tokens.includes(token))
    return fail(world, site, `not_found: ${site} has no link ${token} on ${deckId}.`)
  deck.tokens = deck.tokens.filter((t) => t !== token)
  save(world)
  return answer({ revoked: [token] })
}

function open(world, call) {
  const folder = operand(call.rest, []) ?? '.'
  const file = path.join(folder, '.slideless.json')
  if (!existsSync(file))
    return fail(
      world,
      null,
      `No .slideless.json in ${folder}: push the folder once (slideless push) to link it to a deck.`
    )
  const link = JSON.parse(readFileSync(file, 'utf8'))
  return answer({
    presentationId: link.presentationId,
    baseUrl: link.baseUrl,
    url: `${link.baseUrl}/d/${link.presentationId}`
  })
}

// ── The call ──

const call = parse(argv)
// A call that reads its input is journaled once it has (its length and hash); any other at once.
const readsInput =
  call.verb === 'login' || (call.verb === 'share' && flag(call.rest, '--password-stdin'))
if (!readsInput) journal()
if (call.verb === 'dev' || call.verb === 'snapshot' || call.verb === 'snapshots') {
  // The preview and its versions are the real command's: imported, it reads argv[2] on.
  await import(pathToFileURL(REAL_CLI).href)
} else {
  const world = load()
  switch (call.verb) {
    case 'profiles':
      await profiles(world, call)
      break
    case 'login':
      await login(world, call)
      break
    case 'push':
      push(world, call)
      break
    case 'share':
      await share(world, call)
      break
    case 'unshare':
      unshare(world, call)
      break
    case 'open':
      open(world, call)
      break
    default:
      process.stderr.write(`Error: unknown command ${call.verb ?? '(none)'}\n`)
      end(2)
  }
}
