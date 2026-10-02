/**
 * Settings domain: preferences. The app-wide key-value preferences and the
 * app icon. The app's version, the Mission Control overlay and the haptics are
 * the shell's own and stay on Electron's IPC.
 *
 * Mirrors the preload's preference and app methods as of this change
 * (`src/preload/index.ts`). The types in `src/main/preferences-manager.ts`
 * are the originals until the renderer reads this contract instead; then this
 * module becomes the original.
 */
import { Command, Query } from '@structure-ai/cqrs'
import { Schema } from 'effect'

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export const AppIconSchema = Schema.Literal('dark', 'light', 'claude')

/** The typed keys of `preferences.json`. The file also holds keys the
 *  renderer owns (`tmuxMode`, `selectedClaudeProfileId`, …), which is why
 *  `GetPreference` / `SetPreference` take any string key. */
export const PreferencesView = Schema.Struct({
  activeSkinId: Schema.NullOr(Schema.String),
  appIcon: AppIconSchema,
  telemetryEnabled: Schema.Boolean,
  telemetryInstallId: Schema.NullOr(Schema.String),
  telemetryLastPingAt: Schema.NullOr(Schema.String),
  telemetryNoticeShown: Schema.Boolean,
  feedbackPromptCollapsed: Schema.Boolean,
  missionControlOverlayEnabled: Schema.Boolean,
  /** "Receive pre-release builds". Off by default. */
  prereleaseUpdates: Schema.Boolean,
  /** Keep the agent CLIs on their latest release on their own. On by default. */
  agentAutoUpdate: Schema.Boolean,
  /** The model last picked in a chat composer, by chat adapter id. */
  chatModels: Schema.Record({ key: Schema.String, value: Schema.String }),
  /** The reasoning effort last picked in a chat composer, by chat adapter id. */
  chatEfforts: Schema.Record({ key: Schema.String, value: Schema.String }),
  /** The view last picked in a chat pane (`<pluginId>/<viewId>`). */
  chatView: Schema.NullOr(Schema.String)
})

export const PreferenceKey = Schema.keyof(PreferencesView)

// ---------------------------------------------------------------------------
// Commands and queries
// ---------------------------------------------------------------------------

/** `preferences:get` */
export const GetPreference = Query.define('GetPreference', {
  payload: Schema.Struct({ key: Schema.String }),
  success: Schema.Unknown
})

/** `preferences:set` */
export const SetPreference = Command.define('SetPreference', {
  payload: Schema.Struct({ key: Schema.String, value: Schema.Unknown }),
  success: Schema.Void
})

/** `app:set-icon` — also stores the `appIcon` preference. */
export const SetAppIcon = Command.define('SetAppIcon', {
  payload: Schema.Struct({ icon: AppIconSchema }),
  success: Schema.Void
})
