import { mergeConfig } from 'vitest/config'
import config from './vitest.config.ts'
import UnitSequencer from './scripts/unit-sequencer.mjs'

// Reuse the complete unit selection and isolation settings. Only placement
// and file order differ from the normal local invocation.
export default mergeConfig(config, {
  test: { sequence: { sequencer: UnitSequencer } }
})
