import type { RoutineView } from '@clave/contract/routines/model'

/** The fields the create and edit form holds (PRDCT-4244), apart from the
 *  component so the form file exports components alone. */
export interface RoutineFormValues {
  name: string
  schedule: string
  prompt: string
  cwd: string
  model: string
  account: string
}

export const EMPTY_ROUTINE_FORM: RoutineFormValues = {
  name: '',
  schedule: '30 8 * * 1-5',
  prompt: '',
  cwd: '',
  model: '',
  account: ''
}

export function valuesOf(view: RoutineView): RoutineFormValues {
  const d = view.routine
  return {
    name: d.name,
    schedule: d.schedule,
    prompt: d.prompt,
    cwd: d.cwd,
    model: d.launch.model ?? '',
    account: d.launch.account ?? ''
  }
}

/** One choice of the form's model and account pickers. */
export interface FormChoice {
  value: string
  label: string
  hint?: string
}

/** The models the form offers: the agent's own default first, then the
 *  models the app names (`CLAUDE_MODELS`), and the value a routine already
 *  carries when the list does not know it, so an edit never loses it. */
export function modelChoices(
  models: ReadonlyArray<{ id: string; name: string }>,
  current: string
): FormChoice[] {
  const choices: FormChoice[] = [
    { value: '', label: 'Default', hint: 'The model the agent starts on when none is named' },
    ...models.map((m) => ({ value: m.id, label: m.name }))
  ]
  if (current && !choices.some((c) => c.value === current))
    choices.push({ value: current, label: current, hint: 'Named by hand' })
  return choices
}

/** The accounts the form offers, for the machine the routine runs on: the
 *  pool's pick first, then that machine's accounts by label (the label is
 *  what a `.clave` file carries after a move), and the value a routine
 *  already carries when the machine does not list it. */
export function accountChoices(
  accounts: ReadonlyArray<{ id: string; label: string }>,
  current: string
): FormChoice[] {
  // `any` is the pool's pick, the first choice; a routine made by an agent
  // may carry the account's id, and the picker shows its label.
  if (current === 'any') current = ''
  current = accounts.find((a) => a.id === current)?.label ?? current
  const choices: FormChoice[] = [
    { value: '', label: 'Any from the pool', hint: 'The machine picks the account with headroom' },
    ...accounts.map((a) => ({ value: a.label, label: a.label }))
  ]
  if (current && !choices.some((c) => c.value === current))
    choices.push({ value: current, label: current, hint: 'Not on the machine\u2019s list' })
  return choices
}
