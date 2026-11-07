import * as fs from 'fs'

/**
 * `git rev-parse --show-toplevel` answers with symlinks resolved (`/tmp/x` comes
 * back as `/private/tmp/x` on macOS), while the panel asks in the spelling the
 * user gave. The renderer tells "this folder IS the repo" from "this folder is
 * INSIDE a repo" by comparing the two, so a symlinked root made every repo
 * under it announce itself as part of a parent named after itself
 * (2026-09-21). When the resolved answer is the asked folder, answer in the
 * asked spelling; a genuinely different root keeps git's answer.
 */
export function repoRootAsAsked(asked: string, toplevel: string): string {
  if (!toplevel) return toplevel
  try {
    const askedReal = fs.realpathSync.native(asked)
    const topReal = fs.realpathSync.native(toplevel)
    if (askedReal === topReal) return asked
  } catch {
    // An unreadable path keeps git's answer: there is nothing better to say.
  }
  return toplevel
}
