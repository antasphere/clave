import { Schema } from 'effect'
import { expect, it } from 'vitest'
import { SessionRecord, SpawnOptions } from './sessions'

// A field the schema does not name is dropped on the wire in silence, and
// these two dropped would turn a saved Plan into agy's Auto.
it('carries the Antigravity setting across the wire', () => {
  const sent = {
    permissionMode: 'plan',
    permissionDefault: 'plan',
    permissionModeFromSetting: true
  }
  expect(Schema.decodeUnknownSync(SpawnOptions)(sent)).toMatchObject(sent)
  expect(Object.keys(SessionRecord.fields)).toContain('permissionDefault')
})
