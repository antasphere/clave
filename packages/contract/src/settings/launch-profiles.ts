/**
 * Settings domain: launch profiles. The command line each agent family starts
 * with, the user's own profiles, and which one is the default globally and
 * per workspace.
 *
 * Mirrors the preload's launch profile methods as of this change
 * (`src/preload/index.ts`). The types in `src/shared/agent-launch.ts` are the
 * originals until the renderer reads this contract instead; then this module
 * becomes the original.
 */
import { Command, Query } from '@structure-ai/cqrs'
import { Schema } from 'effect'
import { SettingsRefused } from './failures'

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export const LauncherFamily = Schema.Literal('claude', 'antigravity', 'codex', 'pi')

export const PiThinkingLevel = Schema.Literal(
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
)

export const LaunchProfileView = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  family: LauncherFamily,
  command: Schema.Array(Schema.String),
  additionalArgs: Schema.Array(Schema.String),
  builtIn: Schema.optional(Schema.Boolean),
  /** Host-derived chat variant; edit the source profile to change its command. */
  sourceProfileId: Schema.optional(Schema.String),
  pi: Schema.optional(
    Schema.Struct({
      provider: Schema.optional(Schema.String),
      model: Schema.optional(Schema.String),
      thinking: Schema.optional(PiThinkingLevel)
    })
  )
})

/** A profile id per family, any family absent (`Partial<Record<LauncherFamily, string>>`). */
export const FamilyDefaultsView = Schema.partial(
  Schema.Struct({
    claude: Schema.String,
    antigravity: Schema.String,
    codex: Schema.String,
    pi: Schema.String
  })
)

export const LaunchProfilePreferencesView = Schema.Struct({
  version: Schema.Literal(1),
  customProfiles: Schema.Array(LaunchProfileView),
  globalDefaults: FamilyDefaultsView,
  /** By workspace id. */
  workspaceOverrides: Schema.Record({ key: Schema.String, value: FamilyDefaultsView })
})

// ---------------------------------------------------------------------------
// Commands and queries — every one answers with the whole preferences.
// ---------------------------------------------------------------------------

/** `launch-profiles:list` */
export const ListLaunchProfiles = Query.define('ListLaunchProfiles', {
  payload: Schema.Struct({}),
  success: LaunchProfilePreferencesView
})

/** `launch-profiles:upsert` */
export const UpsertLaunchProfile = Command.define('UpsertLaunchProfile', {
  payload: Schema.Struct({ profile: LaunchProfileView }),
  success: LaunchProfilePreferencesView,
  failure: SettingsRefused
})

/** `launch-profiles:delete` */
export const DeleteLaunchProfile = Command.define('DeleteLaunchProfile', {
  payload: Schema.Struct({ profileId: Schema.String }),
  success: LaunchProfilePreferencesView,
  failure: SettingsRefused
})

/** `launch-profiles:set-global` — null returns the family to its built-in profile. */
export const SetGlobalLaunchProfile = Command.define('SetGlobalLaunchProfile', {
  payload: Schema.Struct({ family: LauncherFamily, profileId: Schema.NullOr(Schema.String) }),
  success: LaunchProfilePreferencesView,
  failure: SettingsRefused
})

/** `launch-profiles:set-workspace` — null drops the workspace's override. */
export const SetWorkspaceLaunchProfile = Command.define('SetWorkspaceLaunchProfile', {
  payload: Schema.Struct({
    workspaceId: Schema.String,
    family: LauncherFamily,
    profileId: Schema.NullOr(Schema.String)
  }),
  success: LaunchProfilePreferencesView,
  failure: SettingsRefused
})
