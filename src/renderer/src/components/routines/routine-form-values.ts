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
