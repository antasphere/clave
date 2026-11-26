import * as path from 'node:path'
import type { WorkspaceFiles } from '@clave/server/workspace-files'
import { workspaceFilesOf, type RegistryWorkspace } from '../routines/resolve'
import { clip } from './scrub'

/**
 * The projects a tab may be working on (PRDCT-5179): the groups of the
 * workspace's `.clave` files, found as the routines find them (the profile
 * file and, with `autoDiscover` on, every project file of the tree) and read
 * as the routines read them, with no reviewer: a file nobody trusted answers
 * null and gives no option, which is the trust boundary applied to a reader
 * that cannot ask. Each group becomes one option of the `tab-project`
 * decision: its name, its folder relative to the workspace, and what it is,
 * in the words of its own prompt.
 */

export interface ProjectOption {
  /** The `.clave` file that declares the group. */
  file: string
  /** The group's name: the choice's option and what a person reads. */
  name: string
  /** The group's `cwd` relative to the workspace's root; `''` for the root. */
  folder: string
  /** The group's prompt, else the longest prompt of its sessions, clipped. */
  description: string
}

/** The longest description an option carries. */
export const OPTION_DESCRIPTION_MAX = 1200

/** A group as an option reads it: the fields of `ClaveGroup` it uses. */
export interface OptionGroup {
  name: string
  cwd: string
  prompt?: string
  sessions?: ReadonlyArray<{ prompt?: string }>
}

/** A folder relative to the workspace's root: `''` for the root itself,
 *  null for a folder outside it. Pure. */
export function folderOf(cwd: string, rootDir: string): string | null {
  const relative = path.relative(path.resolve(rootDir), path.resolve(cwd))
  if (relative === '') return ''
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null
  return relative.split(path.sep).join('/')
}

/** What a group is: its own prompt, else the longest prompt among its
 *  sessions, clipped; `''` when it says nothing. Pure. */
export function describeGroup(group: OptionGroup): string {
  const own = group.prompt?.trim() ?? ''
  if (own) return clip(own, OPTION_DESCRIPTION_MAX)
  let longest = ''
  for (const session of group.sessions ?? []) {
    const said = session.prompt?.trim() ?? ''
    if (said.length > longest.length) longest = said
  }
  return longest ? clip(longest, OPTION_DESCRIPTION_MAX) : ''
}

/**
 * The options of groups read from their files. Pure. A group with no
 * description, or whose folder is outside the workspace, gives none; groups
 * sharing one name give none, not one of them: a decision's answer names a
 * project by its name, and a name that stands for two groups decides nothing.
 */
export function optionsOfGroups(
  read: ReadonlyArray<{ file: string; groups: ReadonlyArray<OptionGroup> }>,
  rootDir: string
): ProjectOption[] {
  const named = new Map<string, number>()
  for (const { groups } of read)
    for (const group of groups) named.set(group.name, (named.get(group.name) ?? 0) + 1)
  const options: ProjectOption[] = []
  for (const { file, groups } of read) {
    for (const group of groups) {
      if (!group.name?.trim() || named.get(group.name) !== 1) continue
      const folder = folderOf(group.cwd, rootDir)
      if (folder === null) continue
      const description = describeGroup(group)
      if (!description) continue
      options.push({ file, name: group.name, folder, description })
    }
  }
  return options
}

/** Every option of a workspace, trusted-or-nothing, as `resolveRoutines`
 *  reads its routines. */
export async function projectOptionsOf(
  files: WorkspaceFiles,
  workspace: RegistryWorkspace
): Promise<ProjectOption[]> {
  let entries: Array<{ path: string; rootDir: string }>
  try {
    entries = await workspaceFilesOf(files, workspace)
  } catch (error) {
    console.error('[decisions] could not list the workspace files of', workspace.rootDir, error)
    return []
  }
  const read: Array<{ file: string; groups: ReadonlyArray<OptionGroup> }> = []
  for (const entry of entries) {
    // No reviewer: an elevated file nobody trusted answers null.
    const result = await files.read(entry.path, { rootDir: entry.rootDir })
    if (!result) continue
    read.push({ file: entry.path, groups: result.type === 'multi' ? result.groups : [result] })
  }
  return optionsOfGroups(read, workspace.rootDir)
}
