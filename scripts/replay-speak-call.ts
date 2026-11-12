/**
 * Speak a text file with the REAL ElevenLabs service, through the app's own
 * integration module and speech host (`src/main/integrations/elevenlabs.ts`,
 * `src/main/speech.ts`), on a throwaway data directory with the encrypted
 * file secret port: the key is read from the environment, sealed there,
 * and never printed. Prints the account's tier and credits, the voices it
 * can speak with, then speaks the text in the app's own parts and writes
 * the audio beside the text file.
 *
 *   ELEVENLABS_API_KEY=… npx vite-node scripts/replay-speak-call.ts <text-file> [--model eleven_flash_v2_5|eleven_multilingual_v2] [--voice <id|name>]
 *
 * A manual probe that spends real credits: never run it from the test suite
 * (its test, `replay-speak-call.test.mjs`, speaks to a closed local port).
 * Every exit, a failure included, removes the throwaway folder and the
 * sealed key in it: nothing in `replaySpeakCall` exits the process, a
 * failure throws, and the exit code is set once the folder is gone.
 * Filed from the PRDCT-4411 hand check, 11 November 2026.
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ELEVENLABS_API, ElevenLabsIntegration } from '../src/main/integrations/elevenlabs'
import { fileSecrets } from '../src/main/ports/secrets'
import { fileStorage } from '../src/main/ports/storage'
import { hostSpeech } from '../src/main/speech'
import { speechChunks } from '../plugins/chat-view/src/lab/speech'
import { isElevenLabsModelId, type ElevenLabsModelId } from '../src/shared/elevenlabs'

export interface ReplayOptions {
  /** Where ElevenLabs is: the real service unless a test names its own. The
   *  script never reads a base URL from the environment (the integration
   *  honours one only under the end-to-end harness). */
  baseUrl?: string
  /** Where the throwaway folder is made; the system's temp folder by default. */
  tmpRoot?: string
  log?: (line: string) => void
  error?: (line: string) => void
}

const USAGE =
  'usage: ELEVENLABS_API_KEY=… npx vite-node scripts/replay-speak-call.ts <text-file> [--model m] [--voice v]'

/** Run the hand check; the exit code it ends with. The throwaway folder (the
 *  sealed key and its master key) is removed on every way out. */
export async function replaySpeakCall(
  args: string[],
  env: NodeJS.ProcessEnv,
  options: ReplayOptions = {}
): Promise<number> {
  const log = options.log ?? ((line: string) => console.log(line))
  const error = options.error ?? ((line: string) => console.error(line))
  const file = args.find((arg, i) => !arg.startsWith('--') && !args[i - 1]?.startsWith('--'))
  const option = (name: string): string | undefined => {
    const at = args.indexOf(`--${name}`)
    return at === -1 ? undefined : args[at + 1]
  }
  const key = env.ELEVENLABS_API_KEY
  if (!file || !key) {
    error(USAGE)
    return 2
  }
  const model = option('model')
  if (model !== undefined && !isElevenLabsModelId(model)) {
    error(`not an ElevenLabs model: ${model}`)
    return 2
  }
  const dir = mkdtempSync(path.join(options.tmpRoot ?? tmpdir(), 'clave-speak-'))
  try {
    await speakFile({ file, key, model, voice: option('voice'), dir, log, base: options.baseUrl })
    return 0
  } catch (failure) {
    error(String(failure instanceof Error ? failure.message : failure))
    return 1
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function speakFile(run: {
  file: string
  key: string
  model: ElevenLabsModelId | undefined
  voice: string | undefined
  dir: string
  log: (line: string) => void
  base: string | undefined
}): Promise<void> {
  const { file, key, model, dir, log } = run
  const text = readFileSync(file, 'utf8').trim()
  // The real service, named here, unless the caller named its own.
  const baseUrl = (): string => run.base ?? ELEVENLABS_API
  const integration = new ElevenLabsIntegration(
    {
      storage: fileStorage(dir),
      secrets: fileSecrets({ directory: path.join(dir, 'secrets') })
    },
    { baseUrl }
  )
  const status = await integration.setKey(key)
  if (status.lastError) throw new Error(`check failed: ${status.lastError}`)
  log(`account: ${status.tier}, ${status.charactersUsed} of ${status.charactersLimit} credits used`)
  const { voices } = await integration.voices()
  log(`voices: ${voices.length}`)
  for (const voice of voices.slice(0, 12))
    log(`  ${voice.voiceId}  ${voice.name}  ${Object.values(voice.labels).join(' · ')}`)
  const wanted = run.voice
  const voice =
    (wanted &&
      voices.find(
        (v) => v.voiceId === wanted || v.name.toLowerCase().startsWith(wanted.toLowerCase())
      )) ??
    voices[0]
  if (!voice) throw new Error('no voice to speak with')
  await integration.setVoice(voice.voiceId, voice.name, model)
  log(`speaking as ${voice.name} with ${model ?? integration.status().modelId}`)
  const speech = hostSpeech(() => ({}), { integration, baseUrl })
  const parts = speechChunks(text, 2_400)
  const audio: Buffer[] = []
  let charged = 0
  const started = Date.now()
  for (const [i, part] of parts.entries()) {
    const at = Date.now()
    const answer = await speech.speak({ sessionId: 'hand-check', text: part })
    if (!answer.ok) throw new Error(`part ${i + 1}: ${answer.reason ?? 'failed'}: ${answer.error}`)
    audio.push(Buffer.from(answer.audio, 'base64'))
    charged += answer.characters
    log(
      `part ${i + 1}/${parts.length}: ${part.length} chars → ${answer.audio.length} b64 in ${((Date.now() - at) / 1000).toFixed(1)}s`
    )
  }
  const out = file.replace(/\.[^.]+$/, '') + `.${model ?? integration.status().modelId}.mp3`
  writeFileSync(out, Buffer.concat(audio))
  log(
    `wrote ${out} (${Buffer.concat(audio).length} bytes), ${charged} credits, ${((Date.now() - started) / 1000).toFixed(1)}s`
  )
  const after = await integration.check()
  log(`account now: ${after.charactersUsed} of ${after.charactersLimit} credits used`)
}

// Run from the command line; imported by its test, it runs nothing.
if (!process.env.VITEST)
  void replaySpeakCall(process.argv.slice(2), process.env).then((code) => {
    process.exitCode = code
  })
