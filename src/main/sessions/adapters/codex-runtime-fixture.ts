import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnCodexAppServer, type CodexCallbacks, type CodexConnection } from './codex-app-server'

/** A login shell seam that keeps tests independent of the machine's profile. */
export function fixtureShell(root: string): string {
  const shell = join(root, 'sh')
  writeFileSync(shell, '#!/bin/sh\n[ "$1" = -l ] && shift\nexec /bin/sh "$@"\n', { mode: 0o755 })
  return shell
}

/** The provider captures its helper path once and actually runs that helper,
 * including through a child. No requests leave this isolated fixture. */
export function installFixtureCodex(root: string, version = 'old'): string {
  const install = join(root, 'Caskroom', 'codex', version)
  mkdirSync(join(install, 'bin'), { recursive: true })
  mkdirSync(join(install, 'codex-resources'))
  mkdirSync(join(install, 'codex-path'))
  writeFileSync(join(install, 'codex-resources', 'version'), version)
  writeFileSync(
    join(install, 'codex-package.json'),
    JSON.stringify({
      layoutVersion: 1,
      entrypoint: 'bin/codex',
      resourcesDir: 'codex-resources',
      pathDir: 'codex-path'
    })
  )
  writeFileSync(
    join(install, 'bin', 'codex-code-mode-host'),
    `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
process.stdout.write('helper-${version}:' + fs.readFileSync(path.join(__dirname, '..', 'codex-resources', 'version'), 'utf8'));
`,
    { mode: 0o755 }
  )
  writeFileSync(
    join(install, 'bin', 'codex'),
    `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const file = fs.realpathSync(process.argv[1]);
const helper = path.join(path.dirname(file), 'codex-code-mode-host');
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const frame = JSON.parse(line);
  if (frame.method === 'fixtureExit') process.exit(0);
  let result = {};
  if (frame.method === 'thread/start' || frame.method === 'thread/resume') result = { thread: { id: frame.params.threadId || 'fresh-thread' }, model: 'fixture-model' };
  if (frame.method === 'model/list') result = { data: [{ id: 'fixture-model', model: 'fixture-model' }] };
  if (frame.method === 'runtime') result = { file, home: process.env.CODEX_HOME, tab: process.env.CLAVE_SESSION_ID, marker: process.env.CLAVE_RUNTIME_MARKER, nodeMode: process.env.ELECTRON_RUN_AS_NODE, authenticated: process.env.CLAVE_CODEX_MCP_TOKEN === 'runtime-fixture-token', args: process.argv.slice(2) };
  if (frame.method === 'helper' || frame.method === 'child') {
    try {
      const output = frame.method === 'helper' ? cp.execFileSync(helper, { encoding: 'utf8' }) : cp.execFileSync(process.execPath, ['-e', 'process.stdout.write(require("node:child_process").execFileSync(process.argv[1], {encoding:"utf8"}))', helper], { encoding: 'utf8' });
      result = { output };
    } catch (error) { result = { error: error.code || error.message, stderr: error.stderr?.toString() }; }
  }
  if (frame.id !== undefined) process.stdout.write(JSON.stringify({ id: frame.id, result }) + '\\n');
});
`,
    { mode: 0o755 }
  )
  return install
}

export function fixtureConnection(
  cwd: string,
  install: string,
  options: {
    prefix?: string[]
    env?: Record<string, string>
    callbacks?: Partial<CodexCallbacks>
  } = {}
): CodexConnection {
  return spawnCodexAppServer(
    cwd,
    {
      notification: () => {},
      request: () => {},
      error: () => {},
      exit: () => {},
      ...options.callbacks
    },
    {
      id: 'fixture',
      name: 'Fixture',
      family: 'codex',
      command: [
        ...(options.prefix ?? []),
        join(install, 'bin', 'codex'),
        '--config',
        'fixture=value'
      ],
      additionalArgs: []
    },
    options.env
  )
}
