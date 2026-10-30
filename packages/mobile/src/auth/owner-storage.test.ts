import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { Drafts, MemoryKeyValueStore } from '../chat/drafts'
import { MemorySecureStore, SecureCredentialStore } from '../machines/credentials'
import { ownerKeyValueStore, ownerSecureStore, ownerNamespace } from './owner-storage'

it('separates machines, credentials and drafts by issuer and subject while preserving the returning owner', async () => {
  const kv = new MemoryKeyValueStore()
  const secure = new MemorySecureStore()
  const a = ownerKeyValueStore(kv, 'issuerA-subjectA')
  const b = ownerKeyValueStore(kv, 'issuerA-subjectB')
  const anotherIssuer = ownerKeyValueStore(kv, 'issuerB-subjectA')
  const aCredentials = new SecureCredentialStore(ownerSecureStore(secure, 'issuerA-subjectA'))
  const bCredentials = new SecureCredentialStore(ownerSecureStore(secure, 'issuerA-subjectB'))
  await new Drafts(a).set('machine', 'session', 'private draft')
  await a.setItem('machines', '["private-machine"]')
  await aCredentials.set('machine', {
    serverUrl: 'https://relay.example/m/machine',
    bearer: 'private-device-bearer'
  })
  expect(await new Drafts(b).get('machine', 'session')).toBe('')
  expect(await anotherIssuer.getItem('machines')).toBeNull()
  expect(await b.getItem('machines')).toBeNull()
  expect(await bCredentials.get('machine')).toBeNull()
  expect(await bCredentials.mainMachineId()).toBeNull()
  // A write started by A remains in A's immutable namespace after B signs in.
  await new Drafts(a).set('machine', 'session', 'late A draft')
  expect(await new Drafts(b).get('machine', 'session')).toBe('')
  expect(
    await new Drafts(ownerKeyValueStore(kv, 'issuerA-subjectA')).get('machine', 'session')
  ).toBe('late A draft')
  expect(await aCredentials.get('machine')).toMatchObject({ bearer: 'private-device-bearer' })
})

it('namespace hashes bind both issuer and subject, including the signed-out case', async () => {
  const hash = async (value: string): Promise<string> =>
    createHash('sha256').update(value).digest('hex')
  const keys = await Promise.all([
    ownerNamespace('https://a.example', 'subject', hash),
    ownerNamespace('https://b.example', 'subject', hash),
    ownerNamespace('https://a.example', 'other', hash),
    ownerNamespace('https://a.example', null, hash),
    ownerNamespace('https://a.example', 'signed-out', hash)
  ])
  expect(new Set(keys).size).toBe(5)
  expect(await ownerNamespace('https://a.example', 'subject', hash)).toBe(keys[0])
  expect(keys.every((key) => /^[A-Za-z0-9._-]+$/.test(key))).toBe(true)
})
