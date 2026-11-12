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
  INTEGRATIONS_NEED_UPDATE,
  type ElevenLabsModelId,
  type ElevenLabsStatus
} from '../../../../shared/elevenlabs'
import {
  EMPTY_MACHINE_INTEGRATIONS,
  accountFigure,
  checkElevenLabs,
  loadElevenLabsVoices,
  loadIntegrations,
  modelChoices,
  removeElevenLabsKey,
  setElevenLabsKey,
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

/**
 * The Integrations page of the Agents group (PRDCT-4410): what a machine can
 * reach on the person's behalf, on the machine the picker names. Today one
 * card, ElevenLabs: a key pasted here is sealed on that machine by its own
 * secret port and checked against the account at once; the voice and the
 * model chosen are the ones the agents' speech uses. The field never shows a
 * stored key: the machine never sends one back. The same component serves
 * this Mac and a server (`ServerPages.tsx` wraps it with the server's notice).
 * The card carries its figure (`VoiceDrawing`): drawn in full beside the
 * field while there is no key, small and still beside the account once there
 * is one.
 */

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
  const [value, setValue] = useState('')
  const submit = async (): Promise<void> => {
    if (busy || !value.trim()) return
    const saved = await setElevenLabsKey(machine, value)
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
      {!onCancel && <VoiceDrawing />}
      <div className="min-w-0 flex-1">
        <p className="settings-row-title">{onCancel ? 'New key' : 'API key'}</p>
        <p className="settings-row-description">
          {onCancel
            ? `Takes the place of the key on ${machineName} once ElevenLabs accepts it.`
            : `Folio reads its pages aloud in the voice you choose. The key is sealed on ${machineName} and never shown again.`}
        </p>
        <input
          className="input-compact mt-2 w-full max-w-md"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="xi-…"
          aria-label="ElevenLabs API key"
          data-testid="elevenlabs-key-input"
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
            data-testid="elevenlabs-key-cancel"
          >
            Cancel
          </button>
        )}
        <button
          type="button"
          className="btn-primary"
          disabled={busy || !value.trim()}
          onClick={() => void submit()}
          data-testid="elevenlabs-key-save"
        >
          {busy ? 'Checking…' : 'Save'}
        </button>
      </div>
    </div>
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
              <span>Checked: the account answered.</span>
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
      <div className="settings-row-controls">
        {(status.lastError || status.checkedAt === null) && (
          <button
            type="button"
            className="btn-secondary"
            disabled={busy}
            onClick={() => void checkElevenLabs(machine)}
            data-testid="elevenlabs-check"
          >
            Check again
          </button>
        )}
        <button
          type="button"
          className="btn-secondary"
          disabled={busy}
          onClick={onReplace}
          data-testid="elevenlabs-replace"
        >
          Replace
        </button>
        <button
          type="button"
          className="btn-secondary"
          disabled={busy}
          onClick={() => void removeElevenLabsKey(machine)}
          data-testid="elevenlabs-remove"
        >
          Remove
        </button>
      </div>
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
  // The voices are read once the card shows a key the account accepted.
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
    <SettingsSection
      title="ElevenLabs"
      description={`The voice Folio reads aloud with on ${machineName}. Each machine holds its own key.`}
    >
      {body}
      {state.status !== 'error' && state.error && (
        <SettingsCallout tone="danger" role="alert" text={state.error} />
      )}
    </SettingsSection>
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
