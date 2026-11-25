/**
 * Settings domain: the writing styles (PRDCT-5166). How an agent writes to
 * the person, as named instructions a machine keeps and every tab it
 * launches starts with, whatever its harness; and the style a tab starts
 * with when its launch names none.
 *
 * Mirrors `src/shared/writing-styles.ts`, the types every side reads, and
 * `src/main/writing-styles/store.ts`, the store on the host. A field these
 * schemas do not name is dropped on the wire, silently: every field of a
 * style and of the view is named here.
 */
import { Command, Query } from '@structure-ai/cqrs'
import { Schema } from 'effect'
import { SettingsRefused } from './failures'

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export const WritingStyleView = Schema.Struct({
  /** Its handle: what a tab's record keeps and an agent names. */
  id: Schema.String,
  name: Schema.String,
  /** One line on when to use it. */
  description: Schema.String,
  /** The instructions, as the agent is given them. */
  text: Schema.String,
  /** Whether each answer ends with the status card. */
  statusCard: Schema.Boolean,
  /** A style Clave ships: read-only, the same on every machine. */
  builtIn: Schema.Boolean
})

/** A machine's styles, its default and Claude Code's output style. */
export const WritingStylesView = Schema.Struct({
  /** The built-in styles first, then the machine's own in the order made. */
  styles: Schema.Array(WritingStyleView),
  /** The style a tab starts with when its launch names none; null is no style. */
  defaultStyleId: Schema.NullOr(Schema.String),
  /** The output style Claude Code is set to on the machine, when it is one
   *  of the person's own files: what the import would copy. */
  claudeOutputStyle: Schema.NullOr(Schema.Struct({ name: Schema.String }))
})

// ---------------------------------------------------------------------------
// Commands and queries — every one answers the whole view.
// ---------------------------------------------------------------------------

/** `writing-styles:list` */
export const ListWritingStyles = Query.define('ListWritingStyles', {
  payload: Schema.Struct({}),
  success: WritingStylesView
})

/** `writing-styles:save` — no `id` makes a style, an `id` rewrites one of
 *  the machine's own. A draft out of the limits, a name taken or a built-in
 *  is refused with the sentence. */
export const SaveWritingStyle = Command.define('SaveWritingStyle', {
  payload: Schema.Struct({
    id: Schema.optional(Schema.String),
    name: Schema.String,
    description: Schema.String,
    text: Schema.String,
    statusCard: Schema.Boolean
  }),
  success: WritingStylesView,
  failure: SettingsRefused
})

/** `writing-styles:delete` — one of the machine's own; the default is
 *  cleared when it was that one. */
export const DeleteWritingStyle = Command.define('DeleteWritingStyle', {
  payload: Schema.Struct({ id: Schema.String }),
  success: WritingStylesView,
  failure: SettingsRefused
})

/** `writing-styles:set-default` — null (or `none`) is no style. */
export const SetDefaultWritingStyle = Command.define('SetDefaultWritingStyle', {
  payload: Schema.Struct({ id: Schema.NullOr(Schema.String) }),
  success: WritingStylesView,
  failure: SettingsRefused
})

/** `writing-styles:import-claude` — Claude Code's output style on the
 *  machine, saved as a style of its own. */
export const ImportClaudeOutputStyle = Command.define('ImportClaudeOutputStyle', {
  payload: Schema.Struct({}),
  success: WritingStylesView,
  failure: SettingsRefused
})
