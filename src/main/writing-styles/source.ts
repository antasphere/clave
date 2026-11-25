import {
  BUILT_IN_STYLES,
  NO_STYLE,
  composeStyleText,
  findStyle,
  type WritingStylesView
} from '../../shared/writing-styles'

/**
 * Where a spawn and the agent tools read the machine's writing styles
 * (PRDCT-5166). The styles have one owner per machine, the process that
 * holds its settings (`store.ts`, installed where the helpers' preferences
 * are: `settings/shell-source.ts` when main is the server,
 * `settings/standalone-source.ts` on a server of its own); the spawn reads
 * them through this module so it imports no settings code, and a process
 * with no store installed reads the built-in styles and no default.
 */

export interface WritingStylesSource {
  view(): WritingStylesView
}

let source: WritingStylesSource | null = null

export function setWritingStylesSource(next: WritingStylesSource | null): void {
  source = next
}

/** The machine's styles and its default, as Settings and the tools read them. */
export function writingStylesView(): WritingStylesView {
  return (
    source?.view() ?? {
      styles: [...BUILT_IN_STYLES],
      defaultStyleId: null,
      claudeOutputStyle: null
    }
  )
}

/** A style as a launch applies it: the id the tab's record keeps, and the
 *  instructions its agent is given. */
export interface LaunchStyle {
  id: string
  text: string
}

export type LaunchStyleAnswer =
  | { ok: true; style: LaunchStyle | null }
  | { ok: false; reason: string }

/**
 * The style a launch runs on. `named` is what the launch said (a style's id
 * or its exact name, or `none`); absent, the machine's default. A style the
 * launch names and the machine does not have is refused with the list, as an
 * unknown launch profile is; a default that no longer exists is no style.
 * `style: null` is no style: nothing is added to the agent's instructions.
 */
export function launchStyle(named: string | undefined): LaunchStyleAnswer {
  const view = writingStylesView()
  if (named === undefined) {
    const fallback = view.defaultStyleId ? findStyle(view.styles, view.defaultStyleId) : null
    if (!fallback || fallback === NO_STYLE) return { ok: true, style: null }
    const text = composeStyleText(fallback)
    return { ok: true, style: text ? { id: fallback.id, text } : null }
  }
  const found = findStyle(view.styles, named)
  if (found === NO_STYLE) return { ok: true, style: null }
  if (!found)
    return {
      ok: false,
      reason: `Unknown writing style "${named}". This machine has: ${[NO_STYLE, ...view.styles.map((style) => style.id)].join(', ')}.`
    }
  const text = composeStyleText(found)
  return { ok: true, style: text ? { id: found.id, text } : null }
}

/** The style a tab's record names, for a tab launched again (a restore, a
 *  resume, an account switch): the same style when the machine still has
 *  it, no style when it was deleted since. Never a refusal: a tab must come
 *  back. */
export function recordedStyle(id: string | undefined): LaunchStyle | null {
  if (!id || id === NO_STYLE) return null
  const answer = launchStyle(id)
  return answer.ok ? answer.style : null
}
