import { appendFileSync } from 'node:fs'

appendFileSync(
  'argv-record.jsonl',
  JSON.stringify({
    argv: process.argv.slice(2),
    sessionId: process.env.CLAVE_SESSION_ID ?? null,
    cwd: process.cwd()
  }) + '\n'
)
process.stdout.write('argv recorder ran\n')
