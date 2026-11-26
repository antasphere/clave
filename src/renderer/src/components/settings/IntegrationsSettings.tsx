import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode
} from 'react'
import { SpeakerWaveIcon } from '@heroicons/react/24/outline'
import { LOCAL_SERVER_ID } from '@clave/contract/fleet'
import {
  ELEVENLABS_KEY_PERMISSIONS,
  INTEGRATIONS_NEED_UPDATE,
  type ElevenLabsModelId,
  type ElevenLabsStatus
} from '../../../../shared/elevenlabs'
import {
  EMPTY_MACHINE_INTEGRATIONS,
  JEV_NEEDS_UPDATE,
  accountFigure,
  checkElevenLabs,
  checkJev,
  checkedOnLine,
  loadElevenLabsVoices,
  loadIntegrations,
  modelChoices,
  removeElevenLabsKey,
  removeJevKey,
  setElevenLabsKey,
  setJevKey,
  setElevenLabsVoice,
  setOnLine,
  useIntegrationsStore,
  voiceChoices,
  type MachineIntegrations
} from '../../store/integrations-store'
import {
  SettingsCallout,
  SettingsCard,
  SettingsPage,
  SettingsSection,
  SettingsSelect
} from './primitives'
import { PlayingGlyph, VoiceDrawing } from './VoiceDrawing'
import { DecisionDrawing } from './DecisionDrawing'
import { JEV_WHAT_LEAVES, type JevStatus } from '../../../../shared/jev'

/**
 * The Integrations page of the Agents group (PRDCT-4410): what a machine can
 * reach on the person's behalf, on the machine the picker names. Today one
 * card, ElevenLabs: a key pasted here is sealed on that machine by its own
 * secret port and checked at once against what Folio uses, the voices and
 * the speech (a refusal says ElevenLabs' own reason, PRDCT-4831); the voice
 * and the model chosen are the ones the agents' speech uses. The field never shows a
 * stored key: the machine never sends one back. The same component serves
 * this Mac and a server (`ServerPages.tsx` wraps it with the server's notice).
 * The card carries its figure (`VoiceDrawing`): drawn in full beside the
 * field while there is no key, small and still beside the account once there
 * is one.
 *
 * Under it, the Jev card (PRDCT-5179): the TypeSafe key the decisions are
 * asked with, sealed the same way and on the same machine, with its own
 * figure (`DecisionDrawing`). The two cards share the paste row and the
 * key's actions; each says its own words.
 */

/** The row a key is pasted in, shared by the cards (PRDCT-5179): the
 *  figure beside it while there is no key, the card's own words, the field,
 *  and Save (with Cancel when it replaces a key). The paste leaves the page
 *  once the machine has it; a failed save keeps it in the field. */
function PasteKeyRow({
  figure,
  title,
  children,
  placeholder,
  ariaLabel,
  testPrefix,
  busy,
  onSave,
  onCancel
}: {
  figure: ReactNode
  title: string
  /** The words under the title, when the card has any. */
  children?: ReactNode
  placeholder: string
  ariaLabel: string
  /** The `data-testid` prefix of the field and its buttons. */
  testPrefix: string
  busy: boolean
  onSave: (apiKey: string) => Promise<boolean>
  /** Set when the field replaces a key already there: no figure then. */
  onCancel?: () => void
}): ReactElement {
  const [value, setValue] = useState('')
  const submit = async (): Promise<void> => {
    if (busy || !value.trim()) return
    const saved = await onSave(value)
    // The paste leaves the page either way once the machine has it.
    if (saved) {
      setValue('')
      onCancel?.()
    }
  }
  return (
    <div
      className="settings-row integration-row"
      data-integration-empty={onCancel ? undefined : ''}
    >
      {!onCancel && figure}
      <div className="min-w-0 flex-1">
        <p className="settings-row-title">{title}</p>
        {children}
        <input
          className="input-compact mt-2 w-full max-w-md"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder={placeholder}
          aria-label={ariaLabel}
          data-testid={`${testPrefix}-key-input`}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void submit()
          }}
        />
      </div>
      <div className="settings-row-controls">
        {onCancel && (
          <button
            type="button"
            className="btn-secondary"
            onClick={onCancel}
            data-testid={`${testPrefix}-key-cancel`}
          >
            Cancel
          </button>
        )}
        <button
          type="button"
          className="btn-primary"
          disabled={busy || !value.trim()}
          onClick={() => void submit()}
          data-testid={`${testPrefix}-key-save`}
        >
          {busy ? 'Checking…' : 'Save'}
        </button>
      </div>
    </div>
  )
}

/** A stored key's three actions, shared by the cards: Check again (when
 *  `onCheck` is given), Replace, Remove. */
function KeyActions({
  testPrefix,
  busy,
  onCheck,
  onReplace,
  onRemove
}: {
  testPrefix: string
  busy: boolean
  onCheck?: () => void
  onReplace: () => void
  onRemove: () => void
}): ReactElement {
  return (
    <div className="settings-row-controls">
      {onCheck && (
        <button
          type="button"
          className="btn-secondary"
          disabled={busy}
          onClick={onCheck}
          data-testid={`${testPrefix}-check`}
        >
          Check again
        </button>
      )}
      <button
        type="button"
        className="btn-secondary"
        disabled={busy}
        onClick={onReplace}
        data-testid={`${testPrefix}-replace`}
      >
        Replace
      </button>
      <button
        type="button"
        className="btn-secondary"
        disabled={busy}
        onClick={onRemove}
        data-testid={`${testPrefix}-remove`}
      >
        Remove
      </button>
    </div>
  )
}

function KeyField({
  machine,
  machineName,
  busy,
  onCancel
}: {
  machine: string
  machineName: string
  busy: boolean
  /** Set when the field replaces a key already there: no figure then. */
  onCancel?: () => void
}): ReactElement {
  return (
    <PasteKeyRow
      figure={<VoiceDrawing />}
      title={onCancel ? 'New key' : 'API key'}
      placeholder="sk_…"
      ariaLabel="ElevenLabs API key"
      testPrefix="elevenlabs"
      busy={busy}
      onSave={(apiKey) => setElevenLabsKey(machine, apiKey)}
      onCancel={onCancel}
    >
      <p className="settings-row-description">
        {onCancel
          ? `Takes the place of the key on ${machineName} once ElevenLabs accepts it.`
          : `Folio reads its pages aloud in the voice you choose. The key is sealed on ${machineName} and never shown again.`}
      </p>
      <p className="settings-row-description" data-testid="elevenlabs-key-permissions">
        {ELEVENLABS_KEY_PERMISSIONS}
      </p>
    </PasteKeyRow>
  )
}

function KeyRow({
  machine,
  status,
  busy,
  onReplace
}: {
  machine: string
  status: ElevenLabsStatus
  busy: boolean
  onReplace: () => void
}): ReactElement {
  const figure = accountFigure(status)
  // A key that passed with no plan and no credits may not read the account
  // (PRDCT-4831): the check stays offered, for once the key is allowed to.
  const noFigures = !!figure && !figure.tier && !figure.credits
  return (
    <div className="settings-row integration-row" data-elevenlabs-key="set">
      <VoiceDrawing quiet />
      <div className="min-w-0 flex-1">
        <p className="settings-row-title">Key</p>
        <p className="settings-row-description" data-testid="elevenlabs-key-set-on">
          {setOnLine(status.setAt)}
        </p>
        {status.lastError ? (
          <p className="text-xs text-destructive" role="alert" data-testid="elevenlabs-check-error">
            {status.lastError}
          </p>
        ) : (
          <div className="integration-account" data-testid="elevenlabs-account">
            {!figure ? (
              <span>Not checked yet.</span>
            ) : !figure.tier && !figure.credits ? (
              <span>Checked: ElevenLabs accepted the key.</span>
            ) : (
              <>
                {figure.tier && (
                  <span className="badge badge-muted integration-tier" title="Plan">
                    {figure.tier}
                  </span>
                )}
                {figure.spent !== null && (
                  <span
                    className="integration-meter"
                    style={{ '--spent': figure.spent } as CSSProperties}
                    aria-hidden="true"
                  />
                )}
                {figure.credits && <span className="integration-credits">{figure.credits}</span>}
              </>
            )}
          </div>
        )}
      </div>
      <KeyActions
        testPrefix="elevenlabs"
        busy={busy}
        onCheck={
          status.lastError || status.checkedAt === null || noFigures
            ? () => void checkElevenLabs(machine)
            : undefined
        }
        onReplace={onReplace}
        onRemove={() => void removeElevenLabsKey(machine)}
      />
    </div>
  )
}

/** The chosen voice's own preview sample, fetched by the machine (its key
 *  never leaves it) and played from a Blob URL; a second click stops it
 *  (PRDCT-4411). */
function usePreview(machine: string): {
  playing: boolean
  error: string | null
  toggle: (voiceId: string) => void
} {
  const [playing, setPlaying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const audio = useRef<HTMLAudioElement | null>(null)
  const url = useRef<string | null>(null)
  const generation = useRef(0)
  const halt = (): void => {
    generation.current += 1
    if (audio.current) {
      audio.current.onended = null
      audio.current.onerror = null
      audio.current.pause()
    }
    if (url.current) URL.revokeObjectURL(url.current)
    url.current = null
    setPlaying(false)
  }
  const haltRef = useRef(halt)
  haltRef.current = halt
  // The page closed, or another machine shown: the sample stops.
  useEffect(() => () => haltRef.current(), [machine])
  const toggle = (voiceId: string): void => {
    if (playing) return halt()
    halt()
    const mine = generation.current
    setPlaying(true)
    setError(null)
    void window.electronAPI.fleetElevenLabsPreview(machine, voiceId).then(
      (answer) => {
        if (generation.current !== mine) return
        if (!answer.ok) {
          setPlaying(false)
          setError(answer.error || 'The preview could not be played.')
          return
        }
        const binary = atob(answer.audio)
        const bytes = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
        const blobUrl = URL.createObjectURL(new Blob([bytes], { type: answer.mime }))
        url.current = blobUrl
        const player = (audio.current ??= new Audio())
        player.onended = () => halt()
        player.onerror = () => {
          halt()
          setError('The preview could not be played.')
        }
        player.src = blobUrl
        player.play().catch(() => {
          halt()
          setError('The preview could not be played.')
        })
      },
      () => {
        if (generation.current !== mine) return
        setPlaying(false)
        setError('The machine did not answer.')
      }
    )
  }
  return { playing, error, toggle }
}

function VoiceRow({
  machine,
  state,
  status
}: {
  machine: string
  state: MachineIntegrations
  status: ElevenLabsStatus
}): ReactElement {
  const { voices } = state
  const choices = voiceChoices(voices.voices, status)
  const preview = usePreview(machine)
  let description: ReactNode
  if (voices.status === 'loading' || voices.status === 'idle')
    description = <p className="settings-row-description">Reading the voices…</p>
  else if (voices.status === 'error')
    description = (
      <p className="text-xs text-destructive" role="alert" data-testid="elevenlabs-voices-error">
        {voices.error}
      </p>
    )
  else
    description = (
      <p className="settings-row-description">
        {status.voiceName
          ? `Folio reads aloud as ${status.voiceName}.`
          : 'Choose the voice Folio reads aloud with.'}
      </p>
    )
  const previewError = preview.error && (
    <p className="text-xs text-destructive" role="alert" data-testid="elevenlabs-preview-error">
      {preview.error}
    </p>
  )
  return (
    <div className="settings-row" data-elevenlabs-voice-row>
      <div className="min-w-0 flex-1">
        <p className="settings-row-title">Voice</p>
        {description}
        {previewError}
      </div>
      <div className="settings-row-controls settings-row-controls-wrap">
        {voices.status === 'error' && (
          <button
            type="button"
            className="btn-secondary"
            onClick={() => void loadElevenLabsVoices(machine)}
            data-testid="elevenlabs-voices-retry"
          >
            Try again
          </button>
        )}
        <SettingsSelect
          value={status.voiceId ?? ''}
          options={choices}
          placeholder="Choose a voice…"
          onChange={(voiceId) => {
            const voice = voices.voices.find((v) => v.voiceId === voiceId)
            void setElevenLabsVoice(machine, voiceId, voice?.name ?? voiceId)
          }}
          ariaLabel="ElevenLabs voice"
          className="integrations-voice-select"
          disabled={state.busy || choices.length === 0}
          testId="elevenlabs-voice"
        />
        <button
          type="button"
          className="btn-secondary integration-preview"
          disabled={!status.voiceId}
          aria-pressed={preview.playing}
          data-playing={preview.playing ? 'true' : undefined}
          title={preview.playing ? 'Stop the sample' : 'Play this voice’s sample'}
          onClick={() => status.voiceId && preview.toggle(status.voiceId)}
          data-testid="elevenlabs-preview"
        >
          {preview.playing ? <PlayingGlyph /> : <SpeakerWaveIcon aria-hidden="true" />}
          {preview.playing ? 'Stop' : 'Preview'}
        </button>
      </div>
    </div>
  )
}

/** The model the voice speaks on, and what it costs, under its name. */
function ModelRow({
  machine,
  state,
  status
}: {
  machine: string
  state: MachineIntegrations
  status: ElevenLabsStatus
}): ReactElement {
  const choices = modelChoices() as { value: ElevenLabsModelId; label: string; hint?: string }[]
  const chosen = choices.find((choice) => choice.value === status.modelId)
  // The model is stored beside the voice: with none chosen yet, the voice
  // stays empty and the model is kept for when one is.
  const setModel = (modelId: ElevenLabsModelId): void =>
    void setElevenLabsVoice(machine, status.voiceId ?? '', status.voiceName ?? '', modelId)
  return (
    <div className="settings-row" data-elevenlabs-model-row>
      <div className="min-w-0 flex-1">
        <p className="settings-row-title">Model</p>
        {chosen?.hint && (
          <p className="settings-row-description">
            {chosen.hint.charAt(0).toUpperCase() + chosen.hint.slice(1)}.
          </p>
        )}
      </div>
      <div className="settings-row-controls">
        <SettingsSelect
          value={status.modelId}
          options={choices}
          onChange={setModel}
          ariaLabel="ElevenLabs model"
          disabled={state.busy}
          testId="elevenlabs-model"
        />
      </div>
    </div>
  )
}

/** The Jev key's row once a key is set (PRDCT-5179): since when, when it
 *  was last checked or TypeSafe's refusal, and the three actions. Jev has no
 *  voice and no model to pick: nothing else. */
function JevKeyRow({
  machine,
  status,
  busy,
  onReplace
}: {
  machine: string
  status: JevStatus
  busy: boolean
  onReplace: () => void
}): ReactElement {
  return (
    <div className="settings-row integration-row" data-jev-key="set">
      <DecisionDrawing quiet />
      <div className="min-w-0 flex-1">
        <p className="settings-row-title">Key</p>
        <p className="settings-row-description" data-testid="jev-key-set-on">
          {setOnLine(status.setAt)}
        </p>
        {status.lastError ? (
          <p className="text-xs text-destructive" role="alert" data-testid="jev-check-error">
            {status.lastError}
          </p>
        ) : (
          <p className="settings-row-description" data-testid="jev-checked">
            {checkedOnLine(status.checkedAt) ?? 'Not checked yet.'}
          </p>
        )}
      </div>
      <KeyActions
        testPrefix="jev"
        busy={busy}
        onCheck={() => void checkJev(machine)}
        onReplace={onReplace}
        onRemove={() => void removeJevKey(machine)}
      />
    </div>
  )
}

/** The Jev card of one machine (PRDCT-5179), under the ElevenLabs one: the
 *  key that lets Clave ask its decisions, sealed on that machine. */
function JevSection({
  machine,
  machineName,
  state
}: {
  machine: string
  machineName: string
  state: MachineIntegrations
}): ReactElement | null {
  // The open Replace field belongs to the machine it was opened for.
  const [replacingOn, setReplacingOn] = useState<string | null>(null)
  const replacing = replacingOn === machine
  const setReplacing = (open: boolean): void => setReplacingOn(open ? machine : null)
  const status = state.jev
  // The machine's integrations could not be read: the ElevenLabs card says
  // so for both.
  if (state.status === 'error' && !status && !state.jevOutdated) return null
  let body: ReactNode
  if (state.jevOutdated)
    body = (
      <SettingsCallout
        role="status"
        title={JEV_NEEDS_UPDATE}
        text={`${machineName} runs a Clave server released before Jev. Its decisions run once it is updated (Settings → Servers).`}
      />
    )
  else
    body = (
      <SettingsCard data-integration="jev" data-integration-machine={machine}>
        {!status ? (
          <div className="settings-row">
            <p className="settings-row-description">Reading…</p>
          </div>
        ) : !status.configured ? (
          <PasteKeyRow
            figure={<DecisionDrawing />}
            title="API key"
            placeholder="ts_…"
            ariaLabel="Jev API key"
            testPrefix="jev"
            busy={state.busy}
            onSave={(apiKey) => setJevKey(machine, apiKey)}
          />
        ) : (
          <>
            <JevKeyRow
              machine={machine}
              status={status}
              busy={state.busy}
              onReplace={() => setReplacing(true)}
            />
            {replacing && (
              <PasteKeyRow
                figure={null}
                title="New key"
                placeholder="ts_…"
                ariaLabel="Jev API key"
                testPrefix="jev"
                busy={state.busy}
                onSave={(apiKey) => setJevKey(machine, apiKey)}
                onCancel={() => setReplacing(false)}
              >
                <p className="settings-row-description">
                  {`Takes the place of the key on ${machineName}; it is checked against TypeSafe at once.`}
                </p>
              </PasteKeyRow>
            )}
          </>
        )}
      </SettingsCard>
    )
  return (
    <SettingsSection
      title="Jev"
      description={`${JEV_WHAT_LEAVES} The key is sealed on ${machineName} and never shown again.`}
    >
      {body}
      {state.jevError && <SettingsCallout tone="danger" role="alert" text={state.jevError} />}
    </SettingsSection>
  )
}

/** The page's body for one machine: its integrations, read when it opens. */
export function IntegrationsList({
  machine,
  machineName
}: {
  machine: string
  machineName: string
}): ReactElement {
  const state = useIntegrationsStore((s) => s.byMachine[machine] ?? EMPTY_MACHINE_INTEGRATIONS)
  // The open Replace field belongs to the machine it was opened for.
  const [replacingOn, setReplacingOn] = useState<string | null>(null)
  const replacing = replacingOn === machine
  const setReplacing = (open: boolean): void => setReplacingOn(open ? machine : null)
  useEffect(() => {
    void loadIntegrations(machine)
  }, [machine])
  const status = state.elevenLabs
  const checked = !!status?.configured && status.checkedAt !== null && !status.lastError
  // The voices are read once the card shows a key ElevenLabs accepted.
  useEffect(() => {
    if (checked && state.voices.status === 'idle') void loadElevenLabsVoices(machine)
  }, [checked, machine, state.voices.status])

  let body: ReactNode
  if (state.status === 'error' && state.error === INTEGRATIONS_NEED_UPDATE)
    body = (
      <SettingsCallout
        role="status"
        title={INTEGRATIONS_NEED_UPDATE}
        text={`${machineName} runs a Clave server released before this page. Its integrations show once it is updated (Settings → Servers).`}
      />
    )
  else if (state.status === 'error' && !status)
    body = (
      <SettingsCallout
        tone="danger"
        role="alert"
        text={state.error ?? `${machineName} did not answer.`}
        actions={
          <button className="btn-secondary" onClick={() => void loadIntegrations(machine)}>
            Try again
          </button>
        }
      />
    )
  else
    body = (
      <SettingsCard data-integration="elevenlabs" data-integration-machine={machine}>
        {!status ? (
          <div className="settings-row">
            <p className="settings-row-description">Reading…</p>
          </div>
        ) : !status.configured ? (
          <KeyField machine={machine} machineName={machineName} busy={state.busy} />
        ) : (
          <>
            <KeyRow
              machine={machine}
              status={status}
              busy={state.busy}
              onReplace={() => setReplacing(true)}
            />
            {replacing && (
              <KeyField
                machine={machine}
                machineName={machineName}
                busy={state.busy}
                onCancel={() => setReplacing(false)}
              />
            )}
            {checked && <VoiceRow machine={machine} state={state} status={status} />}
            {checked && <ModelRow machine={machine} state={state} status={status} />}
          </>
        )}
      </SettingsCard>
    )
  return (
    <>
      <SettingsSection
        title="ElevenLabs"
        description={`The voice Folio reads aloud with on ${machineName}. Each machine holds its own key.`}
      >
        {body}
        {state.status !== 'error' && state.error && (
          <SettingsCallout tone="danger" role="alert" text={state.error} />
        )}
      </SettingsSection>
      <JevSection machine={machine} machineName={machineName} state={state} />
    </>
  )
}

/** This Mac's Integrations page. */
export function IntegrationsSettings(): ReactElement {
  return (
    <SettingsPage
      title="Integrations"
      description="The services this Mac uses on your behalf, each with your own key."
      testId="integrations"
    >
      <IntegrationsList machine={LOCAL_SERVER_ID} machineName="this Mac" />
    </SettingsPage>
  )
}
