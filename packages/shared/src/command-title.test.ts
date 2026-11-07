import { describe, expect, it } from 'vitest'
import { commandTitle } from './command-title'

describe('commandTitle', () => {
  it('reads a long restart chain by the program it is for, and where it runs', () => {
    const command = `pkill -f 'clave-overscroll-demo/user-data' 2>/dev/null; perl -e 'select(undef,undef,undef,2)'; pgrep -fl 'clave-overscroll-demo' | grep -vc zsh; cd /Users/romainpattyn/.antasphere/labs/products/clave/clave-app && exec npm run dev -- -- --user-data-dir="$HOME/clave-overscroll-demo/user-data" > "$HOME/clave-overscroll-demo/dev.log" 2>&1\n`
    expect(commandTitle(command)).toBe('npm run dev in clave-app')
  })

  it('keeps a plain command as it is', () => {
    expect(commandTitle('npm test')).toBe('npm test')
    expect(commandTitle('git status')).toBe('git status')
  })

  it('keeps a short one-liner whole, since it already reads', () => {
    expect(commandTitle('sleep 10 && echo bgc')).toBe('sleep 10 && echo bgc')
    expect(commandTitle('tail -f dev.log | grep error')).toBe('tail -f dev.log | grep error')
  })

  it('keeps a sentence the CLI named the task by', () => {
    expect(commandTitle('Sleep 8 seconds then echo marker in background')).toBe(
      'Sleep 8 seconds then echo marker in background'
    )
  })

  it('stops at the first flag or path', () => {
    expect(commandTitle('npx vitest run apps/desktop/src/renderer/src/views/foo.test.ts --reporter dot')).toBe(
      'npx vitest run'
    )
    expect(commandTitle('/usr/local/bin/node server.js --port 4000 --host 0.0.0.0 --verbose')).toBe(
      'node server.js'
    )
  })

  it('drops wrappers, assignments and redirections before the program', () => {
    expect(commandTitle('PORT=4000 NODE_ENV=development nohup pnpm dev > out.log 2>&1 &')).toBe(
      'pnpm dev'
    )
  })

  it('reads a long pipeline by its first stage', () => {
    expect(commandTitle('tail -f /var/log/clave/dev.log | grep -i error | head -n 50')).toBe('tail')
  })

  it('falls back to the first step when every step only prepares or waits', () => {
    expect(commandTitle('sleep 10 && echo first marker && sleep 20 && echo done')).toBe('sleep 10')
  })

  it('never splits inside quotes', () => {
    expect(commandTitle(`bash -c 'make build && make test; make install --prefix /opt'`)).toBe(
      'bash'
    )
  })

  it('clips what it cannot shorten', () => {
    const title = commandTitle('x'.repeat(200))
    expect(title.length).toBe(60)
    expect(title.endsWith('…')).toBe(true)
  })
})
