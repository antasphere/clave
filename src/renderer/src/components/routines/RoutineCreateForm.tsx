import { useMemo, useState } from 'react'
import { ChevronLeftIcon } from '@heroicons/react/24/outline'
import { IconButton } from '@clave/ui/components'
import type { RoutineCreateInput, RoutinePatch } from '@clave/contract/routines/model'
import {
  accountChoices,
  EMPTY_ROUTINE_FORM,
  modelChoices,
  type RoutineFormValues
} from './routine-form-values'
import { SettingsSelect } from '../settings/primitives'
import { CLAUDE_MODELS } from '../../../../shared/claude-models'
import { describeCron, parseCron } from '../../../../main/routines/cron'

/**
 * The small form a machine's section opens with its “+” (PRDCT-4244): a
 * routine created on that machine, in the workspace the section shows, on
 * the built-in report page. The same form edits a created routine. The
 * machine's refusal (a folder that is not there, an account it does not
 * have, a schedule that does not parse) is shown under the fields, in the
 * machine's words; nothing is written until it accepts. The model and the
 * account are picked, not typed: the models the app names, and the accounts
 * of the machine the routine runs on.
 */
const cronWords = (schedule: string): string | null => {
  try {
    parseCron(schedule)
    return describeCron(schedule)
  } catch {
    return null
  }
}

export function RoutineCreateForm({
  machine,
  workspace,
  accounts,
  initial,
  onSubmit,
  onBack
}: {
  /** The machine the routine is made on, as the section names it. */
  machine: string
  /** The workspace it lives in, as the Mac names it. */
  workspace: { id: string; name: string; rootDir?: string }
  /** The Claude accounts of that machine, by id and label. */
  accounts: ReadonlyArray<{ id: string; label: string }>
  /** The routine edited; absent for a new one. */
  initial?: RoutineFormValues
  /** The create or the update; throws the machine's refusal. */
  onSubmit: (input: RoutineCreateInput | RoutinePatch) => Promise<unknown>
  onBack: () => void
}): React.JSX.Element {
  const [values, setValues] = useState<RoutineFormValues>(initial ?? EMPTY_ROUTINE_FORM)
  const [busy, setBusy] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)
  const words = useMemo(() => cronWords(values.schedule), [values.schedule])
  const models = useMemo(() => modelChoices(CLAUDE_MODELS, values.model), [values.model])
  const accountList = useMemo(
    () => accountChoices(accounts, values.account),
    [accounts, values.account]
  )
  // A routine made by an agent may carry the account's id; the picker holds labels.
  const accountValue =
    values.account === 'any'
      ? ''
      : (accounts.find((a) => a.id === values.account)?.label ?? values.account)
  const ready = values.name.trim() && values.prompt.trim() && words !== null
  const set =
    (key: keyof RoutineFormValues) =>
    (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>): void =>
      setValues((v) => ({ ...v, [key]: event.target.value }))

  const submit = async (): Promise<void> => {
    if (!ready || busy) return
    setBusy(true)
    setRefusal(null)
    const launch = {
      ...(values.model.trim() ? { model: values.model.trim() } : {}),
      ...(values.account.trim() ? { account: values.account.trim() } : {}),
      dangerousMode: true
    }
    const body = {
      name: values.name.trim(),
      schedule: values.schedule.trim(),
      prompt: values.prompt,
      ...(values.cwd.trim() ? { cwd: values.cwd.trim() } : {}),
      launch
    }
    try {
      await onSubmit(initial ? body : { workspaceId: workspace.id, ...body })
      onBack()
    } catch (error) {
      setRefusal(error instanceof Error && error.message ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="routine-form" data-testid="routine-form" data-mode={initial ? 'edit' : 'new'}>
      <div className="routine-head">
        <IconButton
          className="panel-icon-btn routine-back"
          data-testid="routine-form-back"
          aria-label="Back to the routines"
          tooltip="Back"
          onClick={onBack}
        >
          <ChevronLeftIcon className="w-4 h-4" />
        </IconButton>
        <div className="routine-head-text">
          <span className="routine-head-title">
            {initial ? `Edit “${initial.name}”` : `New routine on ${machine}`}
          </span>
          <span className="routine-head-sub">
            {workspace.name}
            {initial ? '' : ' · runs on this machine alone, on the built-in report page'}
          </span>
        </div>
      </div>
      <div className="routine-form-fields">
        <label className="field-label">
          Name
          <input
            className="input-field"
            data-testid="routine-form-name"
            value={values.name}
            onChange={set('name')}
            placeholder="Morning digest"
            autoFocus={!initial}
          />
        </label>
        <label className="field-label">
          Schedule
          <input
            className="input-field font-mono"
            data-testid="routine-form-schedule"
            value={values.schedule}
            onChange={set('schedule')}
            aria-invalid={words === null ? 'true' : undefined}
          />
          <span className="routine-form-hint" data-testid="routine-form-schedule-words">
            {words ?? 'Five cron fields: minute, hour, day of month, month, day of week.'}
          </span>
        </label>
        <label className="field-label">
          What the agent does
          <textarea
            className="textarea-field"
            data-testid="routine-form-prompt"
            rows={5}
            value={values.prompt}
            onChange={set('prompt')}
            placeholder="The job, then what to report."
          />
        </label>
        <label className="field-label">
          Folder
          <input
            className="input-field font-mono"
            data-testid="routine-form-cwd"
            value={values.cwd}
            onChange={set('cwd')}
            placeholder={workspace.rootDir ?? 'The workspace root'}
          />
        </label>
        <div className="routine-form-pair">
          <div className="field-label">
            Model
            <SettingsSelect
              className="routine-form-select"
              testId="routine-form-model"
              ariaLabel="Model"
              value={values.model}
              options={models}
              onChange={(model) => setValues((v) => ({ ...v, model }))}
            />
          </div>
          <div className="field-label">
            Account
            <SettingsSelect
              className="routine-form-select"
              testId="routine-form-account"
              ariaLabel="Account"
              value={accountValue}
              options={accountList}
              onChange={(account) => setValues((v) => ({ ...v, account }))}
            />
          </div>
        </div>
        {refusal && (
          <div
            className="routine-note"
            data-tone="failed"
            role="alert"
            data-testid="routine-form-refusal"
          >
            <div className="routine-note-text">
              <span>{refusal}</span>
            </div>
          </div>
        )}
      </div>
      <div className="routine-form-foot">
        <button className="btn-secondary" onClick={onBack} disabled={busy}>
          Cancel
        </button>
        <button
          className="btn-primary"
          data-testid="routine-form-submit"
          disabled={!ready || busy}
          onClick={() => void submit()}
        >
          {initial ? 'Save' : 'Create'}
        </button>
      </div>
    </div>
  )
}
