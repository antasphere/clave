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
 * A manual probe that spends real credits: never run it from the test suite.
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
import { isElevenLabsModelId } from '../src/shared/elevenlabs'

const args = process.argv.slice(2)
const file = args.find((arg, i) => !arg.startsWith('--') && !args[i - 1]?.startsWith('--'))
const option = (name: string): string | undefined => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? undefined : args[at + 1]
}
const key = process.env.ELEVENLABS_API_KEY
if (!file || !key) {
  console.error(
    'usage: ELEVENLABS_API_KEY=… npx vite-node scripts/replay-speak-call.ts <text-file> [--model m] [--voice v]'
  )
  process.exit(2)
}
const model = option('model')
if (model !== undefined && !isElevenLabsModelId(model)) {
  console.error(`not an ElevenLabs model: ${model}`)
  process.exit(2)
}
const text = readFileSync(file, 'utf8').trim()
const dir = mkdtempSync(path.join(tmpdir(), 'clave-speak-'))
// The real service, named here: the script never reads a base URL from the
// environment (the integration honours one only under the test harness).
const baseUrl = (): string => ELEVENLABS_API
const integration = new ElevenLabsIntegration(
  {
    storage: fileStorage(dir),
    secrets: fileSecrets({ directory: path.join(dir, 'secrets') })
  },
  { baseUrl }
)

async function main(): Promise<void> {
  const status = await integration.setKey(key!)
  if (status.lastError) {
    console.error(`check failed: ${status.lastError}`)
    process.exit(1)
  }
  console.log(
    `account: ${status.tier}, ${status.charactersUsed} of ${status.charactersLimit} credits used`
  )
  const { voices } = await integration.voices()
  console.log(`voices: ${voices.length}`)
  for (const voice of voices.slice(0, 12))
    console.log(`  ${voice.voiceId}  ${voice.name}  ${Object.values(voice.labels).join(' · ')}`)
  const wanted = option('voice')
  const voice =
    (wanted &&
      voices.find(
        (v) => v.voiceId === wanted || v.name.toLowerCase().startsWith(wanted.toLowerCase())
      )) ??
    voices[0]
  if (!voice) throw new Error('no voice to speak with')
  await integration.setVoice(voice.voiceId, voice.name, model)
  console.log(`speaking as ${voice.name} with ${model ?? integration.status().modelId}`)
  const speech = hostSpeech(() => ({}), { integration, baseUrl })
  const parts = speechChunks(text, 2_400)
  const audio: Buffer[] = []
  let charged = 0
  const started = Date.now()
  for (const [i, part] of parts.entries()) {
    const at = Date.now()
    const answer = await speech.speak({ sessionId: 'hand-check', text: part })
    if (!answer.ok) {
      console.error(`part ${i + 1}: ${answer.reason ?? 'failed'}: ${answer.error}`)
      process.exit(1)
    }
    audio.push(Buffer.from(answer.audio, 'base64'))
    charged += answer.characters
    console.log(
      `part ${i + 1}/${parts.length}: ${part.length} chars → ${answer.audio.length} b64 in ${((Date.now() - at) / 1000).toFixed(1)}s`
    )
  }
  const out = file!.replace(/\.[^.]+$/, '') + `.${model ?? integration.status().modelId}.mp3`
  writeFileSync(out, Buffer.concat(audio))
  console.log(
    `wrote ${out} (${Buffer.concat(audio).length} bytes), ${charged} credits, ${((Date.now() - started) / 1000).toFixed(1)}s`
  )
  const after = await integration.check()
  console.log(`account now: ${after.charactersUsed} of ${after.charactersLimit} credits used`)
}

main()
  .catch((error) => {
    console.error(String(error instanceof Error ? error.message : error))
    process.exit(1)
  })
  .finally(() => rmSync(dir, { recursive: true, force: true }))
