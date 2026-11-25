/** The integrations a machine holds (PRDCT-4410): ElevenLabs, and the Jev key
 *  of the decisions (PRDCT-5179), both in one document (`document.ts`). */
export {
  ElevenLabsIntegration,
  elevenLabsIntegration,
  INTEGRATIONS_FILE,
  ELEVENLABS_NO_KEY,
  ELEVENLABS_REFUSED,
  ELEVENLABS_UNREACHABLE,
  type ElevenLabsIntegrationOptions,
  type ElevenLabsModelId,
  type ElevenLabsStatus,
  type ElevenLabsVoice
} from './elevenlabs'
export {
  JevIntegration,
  jevIntegration,
  jevBaseUrl,
  jevBaseUrlOverride,
  JEV_API,
  JEV_NO_KEY,
  JEV_REFUSED,
  JEV_UNREACHABLE,
  type JevIntegrationOptions,
  type JevStatus
} from './jev'
export { readIntegrationEntry, writeIntegrationEntry, serialIntegrations } from './document'
