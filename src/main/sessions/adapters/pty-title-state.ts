import { codexStateFromTitle, type CodexTitleState } from '../../../shared/codex-state'

/** Consume OSC titles across PTY chunks, including both BEL and ST endings.
 * Only titles drive state; terminal body text is deliberately ignored. */
export function codexTitleReader(
  onState: (state: CodexTitleState) => void
): (data: string) => void {
  let pending = ''
  return (data) => {
    pending += data
    for (;;) {
      const start = pending.indexOf('\x1b]')
      if (start < 0) {
        pending = pending.endsWith('\x1b') ? '\x1b' : ''
        return
      }
      pending = pending.slice(start)
      const bell = pending.indexOf('\x07', 2)
      const st = pending.indexOf('\x1b\\', 2)
      const end = bell < 0 ? st : st < 0 ? bell : Math.min(bell, st)
      if (end < 0) {
        if (pending.length > 4096) pending = ''
        return
      }
      const title = pending.slice(2, end)
      if (title.startsWith('0;') || title.startsWith('2;'))
        onState(codexStateFromTitle(title.slice(2)))
      pending = pending.slice(end + (end === st ? 2 : 1))
    }
  }
}
