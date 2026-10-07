/**
 * Settings domain: preferences. Main's own typed preferences, `preferences.json`
 * (`src/main/preferences-manager.ts`): the app icon, the telemetry ids, the
 * pre-release toggle, the chat defaults. Every key is written by the feature
 * that owns it (the icon through `SetAppIcon` here, the pre-release toggle
 * through the updater, the chat defaults through the sessions), never through
 * a free get/set. The free-key store the renderer reaches with
 * `preferences:get` / `preferences:set` is another file, `clave-preferences.json`,
 * owned by the `.clave` trust boundary (`ipc-handlers/clave-file-handlers.ts`)
 * and not part of this module.
 *
 * Mirrors the preload's app-icon method as of this change
 * (`src/preload/index.ts`). The `Preferences` interface in
 * `src/main/preferences-manager.ts` is the original until the renderer reads
 * this contract instead; then this module becomes the original.
 */
import { Command } from '@structure-ai/cqrs'
import { Schema } from 'effect'
import { RefusedOrUnavailable } from './failures'

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export const AppIconSchema = Schema.Literal('dark', 'light', 'claude')

/** The keys of `preferences.json`, main's own. */
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

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** `app:set-icon`: stores the `appIcon` preference and repaints the Dock
 *  tile; a server with no Dock (the standalone entry) answers
 *  `CapabilityUnavailable`. */
export const SetAppIcon = Command.define('SetAppIcon', {
  payload: Schema.Struct({ icon: AppIconSchema }),
  success: Schema.Void,
  failure: RefusedOrUnavailable
})
