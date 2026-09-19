import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, test, vi } from 'vitest'
import { ConversationService } from './service'
import { LegacyMigrationCoordinator, type LegacyMigrationRecord } from './legacy-migration'
import type { AdapterLaunch } from './adapter'

const directories: string[] = []
afterEach(() =>
  directories.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }))
)
const id = '11111111-1111-4111-8111-111111111111'
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'clave-migration-'))
  directories.push(dir)
  const factory = vi.fn(() => {
    throw new Error('Migration must never start a provider')
  })
  let service = new ConversationService(dir, factory)
  let source: LegacyMigrationRecord | undefined = {
    id,
    recordKey: id,
    cwd: '/project',
    folderName: 'Project',
    claudeMode: true,
    codexMode: false,
    piMode: false,
    antigravityMode: false,
    claudeAgentsMode: false,
    dangerousMode: false,
    claudeSessionId: 'native-id',
    launchProfileId: 'stored-profile',
    claudeProfileId: 'stored-account',
    configDir: '/account',
    view: { url: 'http://localhost:3000', command: 'npm run dev' },
    live: true
  }
  const prepare = vi.fn(async (record: LegacyMigrationRecord) => {
    const options = {
      provider: 'claude',
      cwd: record.cwd,
      launchProfileId: record.launchProfileId,
      claudeProfileId: record.claudeProfileId,
      configDir: record.configDir
    }
    return {
      options,
      launch: {
        options,
        command: ['/fake'],
        additionalArgs: [],
        sessionDirectory: dir,
        env: { SECRET: 'never persisted' }
      } as AdapterLaunch
    }
  })
  const stopAndForget = vi.fn(async () => {
    source = undefined
  })
  const finalize = vi.fn(async () => {})
  const deps = {
    read: () => source,
    client: async () => ({
      legacyImportMappings: async () => service.legacyImportMappings(),
      snapshot: async (target: string) => service.snapshot(target),
      prepareLegacyImport: service.prepareLegacyImport.bind(service),
      completeLegacyImport: async (target: string) => service.completeLegacyImport(target)
    }),
    prepare,
    stopAndForget,
    finalize
  }
  return {
    dir,
    factory,
    prepare,
    stopAndForget,
    finalize,
    deps,
    coordinator: new LegacyMigrationCoordinator(deps),
    source: () => source!,
    service: () => service,
    restart: () => {
      service = new ConversationService(dir, factory)
      return new LegacyMigrationCoordinator(deps)
    }
  }
}

test('migration is lazy, idempotent, preserves account/view and never persists environment', async () => {
  const f = fixture()
  const [a, b] = await Promise.all([f.coordinator.migrate(id), f.coordinator.migrate(id)])
  expect(a).toEqual(b)
  expect(a.snapshot.session.id).toBe(`conversation-${id}`)
  expect(a.snapshot.session).toMatchObject({
    launchProfileId: 'stored-profile',
    claudeProfileId: 'stored-account',
    configDir: '/account',
    resumeSessionId: 'native-id',
    legacyImport: { sourceId: id, complete: true },
    view: { url: 'http://localhost:3000', command: 'npm run dev' }
  })
  expect(f.stopAndForget).toHaveBeenCalledTimes(1)
  expect(f.factory).not.toHaveBeenCalled()
  expect(await f.coordinator.migrate(id)).toEqual(a)
  expect(readFileSync(join(f.dir, `${a.snapshot.session.id}.json`), 'utf8')).not.toContain(
    'never persisted'
  )
})

test('profile validation failure does not prepare or stop the source', async () => {
  const f = fixture()
  f.prepare.mockRejectedValueOnce(new Error('Invalid profile'))
  await expect(f.coordinator.migrate(id)).rejects.toThrow('Invalid profile')
  expect(f.stopAndForget).not.toHaveBeenCalled()
  expect(f.source().live).toBe(true)
  expect(await f.coordinator.mappings()).toEqual({})
})

test('failed stop leaves a prepared import unsendable and restart retries it without duplication', async () => {
  const f = fixture()
  f.stopAndForget.mockRejectedValueOnce(new Error('Kill failed'))
  await expect(f.coordinator.migrate(id)).rejects.toThrow('Kill failed')
  expect(f.source().live).toBe(true)
  expect(await f.coordinator.mappings()).toEqual({ [id]: `conversation-${id}` })
  await expect(f.service().send(`conversation-${id}`, 'hello', 'one')).rejects.toThrow(
    'not complete'
  )
  const restored = f.restart()
  await expect(f.service().send(`conversation-${id}`, 'hello', 'one')).rejects.toThrow(
    'not complete'
  )
  expect((await restored.migrate(id)).snapshot.session.legacyImport?.complete).toBe(true)
  expect(f.prepare).toHaveBeenCalledTimes(1)
  expect(f.factory).not.toHaveBeenCalled()
})

test('crash after record removal recovers from durable import and retries layout remapping', async () => {
  const f = fixture()
  f.finalize.mockRejectedValueOnce(new Error('Layout write failed'))
  await expect(f.coordinator.migrate(id)).rejects.toThrow('Layout write failed')
  expect(f.source()).toBeUndefined()
  const restored = f.restart()
  expect((await restored.inspect(id)).targetId).toBe(`conversation-${id}`)
  expect((await restored.migrate(id)).snapshot.session.legacyImport?.complete).toBe(true)
  expect(f.finalize).toHaveBeenCalledTimes(2)
  expect(f.prepare).toHaveBeenCalledTimes(1)
})

test('Codex without recorded native ID warns, and hidden/unsupported sessions cannot migrate', async () => {
  const f = fixture()
  Object.assign(f.source(), { claudeMode: false, codexMode: true })
  expect((await f.coordinator.inspect(id)).warning).toContain('fresh conversation')
  expect((await f.coordinator.inspect(id)).resumeSessionId).toBeUndefined()
  f.source().link = { kind: 'session-view', ownerId: 'owner' }
  await expect(f.coordinator.inspect(id)).rejects.toThrow('cannot be migrated')
  await expect(f.coordinator.migrate(id)).rejects.toThrow('cannot be migrated')
  expect(f.stopAndForget).not.toHaveBeenCalled()
})

test('view updates validate strictly, persist, clear, and archived imports still map', async () => {
  const f = fixture()
  const { snapshot } = await f.coordinator.migrate(id)
  const target = snapshot.session.id
  expect(() =>
    f.service().updateMetadata(target, { view: { url: 'javascript:alert(1)' } })
  ).toThrow()
  expect(() =>
    f
      .service()
      .updateMetadata(target, { view: { url: 'http://localhost', title: 'x'.repeat(8193) } })
  ).toThrow()
  f.service().updateMetadata(target, { view: { url: 'https://example.com', cwd: '/project' } })
  f.restart()
  expect(f.service().snapshot(target).session.view).toEqual({
    url: 'https://example.com',
    cwd: '/project'
  })
  f.service().updateMetadata(target, { view: null })
  expect(f.service().snapshot(target).session.view).toBeUndefined()
  await f.service().close(target)
  expect(await f.coordinator.mappings()).toEqual({ [id]: target })
  expect((await f.coordinator.migrate(id)).snapshot.session.status).toBe('closed')
})
