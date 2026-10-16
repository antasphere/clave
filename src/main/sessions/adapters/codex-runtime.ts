import { mkdtempSync, promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'

const quote = (arg: string): string => "'" + arg.replace(/'/g, "'\\''") + "'"

/** Only rewrite a direct Codex command or an env wrapper. Other providers and
 * arbitrary wrappers keep their own executable resolution and lifecycle. */
function codexCommandIndex(argv: string[]): number {
  if (basename(argv[0]) === 'codex') return 0
  if (basename(argv[0]) !== 'env') return -1
  let i = 1
  while (i < argv.length) {
    if (argv[i] === '-u' || argv[i] === '--unset') i += 2
    else if (argv[i] === '-i' || argv[i] === '--ignore-environment') i++
    else if (argv[i].startsWith('--unset=') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[i])) i++
    else if (argv[i] === '--') {
      i++
      break
    } else break
  }
  return argv[i] && basename(argv[i]) === 'codex' ? i : -1
}

/** All app-servers in this process share retained installations. A fresh root
 * replaces the old one before asynchronous cleanup, so a new launch cannot
 * race the previous root's removal. No expensive copy runs in Electron main. */
let retained: { root: string; users: number } | undefined
function lease(): { root: string; release(): void } {
  const runtime = (retained ??= {
    root: mkdtempSync(join(tmpdir(), 'clave-codex-runtime-')),
    users: 0
  })
  runtime.users++
  let released = false
  return {
    root: runtime.root,
    release() {
      if (released) return
      released = true
      if (--runtime.users !== 0) return
      if (retained === runtime) retained = undefined
      void fs.rm(runtime.root, { recursive: true, force: true }).catch(() => {
        console.warn('[codex-runtime] Could not remove the retired runtime directory')
      })
    }
  }
}

/** Executed by the app's Node runtime, after the login shell and inside the
 * profile's env wrapper. It prints only the retained executable path. Keep
 * this script self-contained: it also runs from a packaged Electron app.
 * cp uses filesystem clones when available, dereferencing installer symlinks
 * so removal of the original package cannot strand a retained resource. */
const PREPARE = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
let staging;
try {
  const command = process.argv[1];
  const cache = process.argv[2];
  const candidates = command.includes('/') ? [path.resolve(command)] :
    (process.env.PATH || '').split(path.delimiter).map(dir => path.resolve(dir, command));
  const executable = candidates.find(file => {
    try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); }
    catch { return false; }
  });
  if (!executable) throw new Error('Codex is not executable on this profile PATH');
  const source = fs.realpathSync(executable);
  const bin = path.dirname(source);
  const manifest = path.join(path.dirname(bin), 'codex-package.json');
  const helper = path.join(bin, 'codex-code-mode-host');
  let packageRoot;
  if (fs.existsSync(manifest)) {
    const layout = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    if (layout.layoutVersion !== 1 || layout.entrypoint !== 'bin/codex')
      throw new Error('Unsupported Codex standalone package layout');
    packageRoot = path.dirname(bin);
    for (const key of ['resourcesDir', 'pathDir']) {
      const value = layout[key];
      if (typeof value !== 'string' || !value || path.isAbsolute(value) ||
          path.relative(packageRoot, path.resolve(packageRoot, value)).startsWith('..'))
        throw new Error('Invalid Codex standalone resource path');
      if (!fs.statSync(path.join(packageRoot, value)).isDirectory())
        throw new Error('Missing Codex standalone resources');
    }
    fs.accessSync(helper, fs.constants.X_OK);
  } else if (!fs.existsSync(helper)) {
    // Older single-file and npm launchers without this standalone layout
    // retain their existing launch path. Do not copy an entire npm prefix.
    process.stdout.write(executable + '\n');
    process.exit(0);
  }
  const stat = fs.statSync(source);
  const identity = [source, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
  const key = crypto.createHash('sha256').update(identity).digest('hex');
  const target = path.join(cache, key);
  const relative = packageRoot ? path.relative(packageRoot, source) : path.basename(source);
  const destination = path.join(target, relative);
  if (!fs.existsSync(destination)) {
    staging = fs.mkdtempSync(path.join(cache, 'preparing-'));
    const options = { recursive: true, dereference: true, mode: fs.constants.COPYFILE_FICLONE };
    if (packageRoot) fs.cpSync(packageRoot, staging, options);
    else {
      fs.cpSync(source, path.join(staging, path.basename(source)), options);
      fs.cpSync(helper, path.join(staging, 'codex-code-mode-host'), options);
    }
    // Publish only a complete copy. Concurrent starts may publish the same
    // immutable installation; each losing staging directory is disposable.
    try { fs.renameSync(staging, target); staging = undefined; }
    catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(error.code) || !fs.existsSync(destination)) throw error;
    }
  }
  fs.accessSync(destination, fs.constants.X_OK);
  process.stdout.write(destination + '\n');
} catch (error) {
  process.stderr.write('Clave could not retain the Codex runtime. Check or reinstall the CLI, then restart this chat: ' + error.message + '\n');
  process.exitCode = 1;
} finally {
  if (staging) fs.rmSync(staging, { recursive: true, force: true });
}
`

/** Resolve and retain before exec, preserving the profile's arguments and
 * account bindings on both invocations. ELECTRON_RUN_AS_NODE is scoped to
 * preparation; it is never added to the provider's environment. */
export function retainedCodexLaunch(
  argv: string[],
  assignment: string
): { command: string; release(): void } {
  const index = codexCommandIndex(argv)
  if (index < 0)
    return { command: `${assignment}exec ${argv.map(quote).join(' ')}`, release: () => {} }
  const runtime = lease()
  const prepare = [
    ...argv.slice(0, index),
    process.execPath,
    '-e',
    PREPARE,
    argv[index],
    runtime.root
  ]
  const command = argv.map((arg, i) => (i === index ? '"$_clave_codex_runtime"' : quote(arg)))
  const result = quote(join(runtime.root, `launch-${randomUUID()}`))
  return {
    command:
      // A background preparation with an explicit PID lets a close cancel a
      // blocked copy/read. Killing only a shell's command substitution leaves
      // its Node child holding the protocol pipes open indefinitely.
      `(${assignment}ELECTRON_RUN_AS_NODE=1 exec ${prepare.map(quote).join(' ')}) > ${result} & ` +
      `_clave_prepare_pid=$!; ` +
      `trap 'kill "$_clave_prepare_pid" 2>/dev/null; wait "$_clave_prepare_pid" 2>/dev/null; exit 143' TERM INT HUP; ` +
      `wait "$_clave_prepare_pid" || exit $?; ` +
      `IFS= read -r _clave_codex_runtime < ${result} || exit 1; ` +
      `trap - TERM INT HUP; ` +
      `${assignment}exec ${command.join(' ')}`,
    release: runtime.release
  }
}
