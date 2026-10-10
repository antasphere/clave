/**
 * The `@`-tokens a `.clave` prompt may carry, and how they expand at spawn.
 *
 * A leaf module on purpose: pure string work with no imports, so it can be unit
 * tested without booting a store or a window. Token expansion is the half of
 * prompt delivery that can be decided without a running app — the other half,
 * the expanded string reaching the agent, is the Electron specs' job.
 */

/** Substitute prompt path tokens at spawn time. macOS-only app → absolute paths
 *  use `/`, so this is pure string work (the renderer has no Node `path`).
 *  @root_path → workspace root, @project_path → project dir relative to root
 *  (`.` if equal, absolute if outside root), @project_abs → project dir absolute.
 *  No-op when the prompt contains no tokens. */
export function substituteTokens(
  prompt: string,
  workspaceRoot: string | null,
  projectAbs: string
): string {
  const root = (workspaceRoot ?? projectAbs).replace(/\/+$/, '')
  const rel =
    projectAbs === root
      ? '.'
      : projectAbs.startsWith(root + '/')
        ? projectAbs.slice(root.length + 1)
        : projectAbs
  return prompt
    .replaceAll('@project_abs', projectAbs)
    .replaceAll('@project_path', rel)
    .replaceAll('@root_path', root)
}
