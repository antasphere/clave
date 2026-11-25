import type { JevAnswers, JevRequest } from './jev-client'

/**
 * The decisions' registry (README.md beside this file), the mirror of the
 * helpers' one (`../helpers/registry.ts`): every question Clave asks Jev on
 * its own is a decision declared here once, with the request it builds, the
 * reading of the answer and its defaults, and run by the one runner
 * (`runner.ts`). Pure and free of Electron: the standalone server loads it.
 */

export interface DecisionDefinition<Input, Outcome> {
  /** Stable, kebab-case: the key its switch is filed under. */
  id: string
  /** What a person reads in Settings. */
  label: string
  /** One sentence a person reads in Settings: what it decides and what it
   *  sends to decide it. */
  description: string
  /** The versioned model the decision's floors were measured on. */
  model: string
  /** Asked once when the service says `model` no longer exists. */
  fallbackModel?: string
  timeoutMs: number
  /** The request; null when there is nothing to ask (no request is sent). */
  build(input: Input): JevRequest | null
  /** The answers read back; null when they are not the asked shape. */
  read(answers: JevAnswers, input: Input): Outcome | null
}

/** What the runner asks before each request. */
export interface DecisionConfig {
  enabled: boolean
  /** This process runs no decision (a server of its own backs the window
   *  and runs them all): the sentence the refusal carries. */
  refused?: string
}

/** Where the switches come from (the Settings page): a partial answer per
 *  decision, merged over the defaults (on). */
export type DecisionConfigSource = (id: string) => Partial<DecisionConfig> | undefined

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

// A definition is stored with its types erased; `defineDecision` hands the
// caller back the typed one, so the runner's signature keeps them.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDecision = DecisionDefinition<any, any>
const decisions = new Map<string, AnyDecision>()
let configSource: DecisionConfigSource = () => undefined

/** Declare a decision. Once per id: a second declaration of the same id is a
 *  bug (two requests behind one switch), so it throws. */
export function defineDecision<Input, Outcome>(
  definition: DecisionDefinition<Input, Outcome>
): DecisionDefinition<Input, Outcome> {
  if (!KEBAB.test(definition.id))
    throw new Error(`Decision id "${definition.id}" is not kebab-case`)
  const known = decisions.get(definition.id)
  if (known && known !== definition)
    throw new Error(`Decision "${definition.id}" is declared twice`)
  decisions.set(definition.id, definition)
  return definition
}

/** Every decision declared so far, in the order of their labels. */
export function listDecisions(): AnyDecision[] {
  return [...decisions.values()].sort((a, b) => a.label.localeCompare(b.label))
}

export function decisionById(id: string): AnyDecision | undefined {
  return decisions.get(id)
}

/** THE seam: is this decision on, and may this process run it at all. On by
 *  default; an installed source (`setDecisionConfigSource`) overrides any
 *  field it answers. */
export function decisionConfig(definition: AnyDecision): DecisionConfig {
  const override = configSource(definition.id) ?? {}
  return {
    enabled: override.enabled ?? true,
    // Passed through, so the runner refuses before any request.
    ...(override.refused && { refused: override.refused })
  }
}

/** Install where the switches come from; no argument puts the defaults back. */
export function setDecisionConfigSource(source?: DecisionConfigSource): void {
  configSource = source ?? (() => undefined)
}

/** Forget every declaration and the source (test seam). */
export function resetDecisionsForTests(): void {
  decisions.clear()
  configSource = () => undefined
}
