/**
 * Which projects a tab works on, on the wire (PRDCT-5179): the Effect Schema
 * mirror of the plain types in `tab-projects-rules.ts`, as `work.ts` mirrors
 * `work-rules.ts`. The rules live there (what a record's reading keeps, how an
 * answer becomes a reading, how a group reads its tabs), in plain TypeScript
 * the renderer imports; this file is only what crosses the wire: a record's
 * `projects`. `tab-projects.test.ts` holds the two copies together.
 *
 * A reading a record carries is checked here to the lengths the rules keep,
 * the same lengths `sanitizeTabProjects` reads a record back with.
 */
import { Schema } from 'effect'
import { PROJECT_LIMITS, PROJECT_STATUSES } from './tab-projects-rules'

export const ProjectStatus = Schema.Literal(...PROJECT_STATUSES)

/** A share of a choice, 0 to 1. */
const Share = Schema.Number.pipe(Schema.between(0, 1))
const Text = (max: number): Schema.filter<typeof Schema.String> =>
  Schema.String.pipe(Schema.minLength(1), Schema.maxLength(max))

/** A project a tab was read on: a group of a `.clave` file, with its share. */
export const ProjectPick = Schema.Struct({
  file: Text(PROJECT_LIMITS.file),
  name: Text(PROJECT_LIMITS.name),
  p: Share
})

/** A tab's reading, as its record keeps it. */
export const TabProjects = Schema.Struct({
  status: ProjectStatus,
  picks: Schema.mutable(Schema.Array(ProjectPick).pipe(Schema.maxItems(PROJECT_LIMITS.picks))),
  fits: Share,
  readAt: Schema.Number.pipe(Schema.finite(), Schema.nonNegative()),
  model: Text(PROJECT_LIMITS.model),
  basis: Text(PROJECT_LIMITS.basis)
})
