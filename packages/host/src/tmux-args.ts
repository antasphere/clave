/**
 * The argument vector for destroying ONE tmux session by name.
 *
 * `tmux kill-session -t <name>` prefix-matches: when the exact name is gone,
 * tmux resolves `-t foo` to `foo-2` and kills that sibling instead. Clave's
 * session names are exactly that shape (`clave-wt-demo-nuit-10ds3a`, then
 * `-2`, `-3` for the same folder), so a close of an already-dead session
 * could take a live neighbour with it. The `=` prefix asks for an exact
 * match, and an absent name is then a no-op rather than a near miss.
 * Pure, so vitest pins it; every kill-session call in the app goes through it.
 */
export function tmuxKillSessionArgs(socket: string, name: string): string[] {
  return ['-L', socket, 'kill-session', '-t', `=${name}`]
}
