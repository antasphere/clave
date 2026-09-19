import { describe, expect, it } from 'vitest'
import { parseConversationCommand } from './launch'
import { parseArtifactInput, parsePluginBindings } from './plugin-records'
import { validateManifest } from '../runtime-plugins/manifest'

describe('plugin conversation boundary', () => {
  it.each(['internal_reports', 'internal/reports', '1reports'])(
    'rejects unusable ID %s before installation',
    (id) => {
      expect(() =>
        validateManifest({
          apiVersion: 1,
          id,
          name: 'Invalid plugin',
          version: '1.0.0',
          views: [
            {
              id: 'view',
              name: 'View',
              entry: 'view.html',
              mimeTypes: ['text/html'],
              capabilities: []
            }
          ]
        })
      ).toThrow()
    }
  )
  it('accepts a provider ID but not caller-chosen revision bindings', () => {
    const options = { provider: 'internal.echo', cwd: '/workspace' }
    expect(parseConversationCommand({ type: 'create', options }).type).toBe('create')
    expect(() =>
      parseConversationCommand({
        type: 'create',
        options: { ...options, pluginBindings: { provider: {}, views: [] } }
      })
    ).toThrow()
  })
  it('requires a durable artifact fallback and a safe source URL', () => {
    const artifact = {
      title: 'Report',
      mimeType: 'text/html',
      content: '<h1>Report</h1>',
      fallback: 'Report summary'
    }
    expect(parseArtifactInput(artifact).content).toBe(artifact.content)
    expect(() => parseArtifactInput({ ...artifact, fallback: '' })).toThrow()
    expect(() => parseArtifactInput({ ...artifact, sourceUrl: 'javascript:alert(1)' })).toThrow()
    expect(() =>
      parseArtifactInput({ ...artifact, sourceUrl: 'https://user:secret@example.com/' })
    ).toThrow()
    expect(() => parseArtifactInput({ ...artifact, capabilities: ['workspace.execute'] })).toThrow()
  })
  it('bounds UTF8 artifact envelopes and rejects ambiguous view pins', () => {
    expect(() =>
      parseArtifactInput({
        title: 'Huge',
        mimeType: 'text/plain',
        content: '漢'.repeat(128 * 1024),
        fallback: 'Huge'
      })
    ).toThrow()
    const pin = { pluginId: 'internal.example', revision: 'one', version: '1.0.0' }
    expect(() =>
      parsePluginBindings({ provider: pin, views: [pin, { ...pin, revision: 'two' }] })
    ).toThrow()
    expect(() =>
      parsePluginBindings({ provider: { ...pin, revision: '../outside' }, views: [] })
    ).toThrow()
  })
})
