import type { InstalledRuntimePlugin } from '../../shared/runtime-plugins'
import type { AdapterFactory } from '../conversations/adapter'
import { ClaudeAdapter } from '../conversations/adapters/claude'
import { CodexAdapter } from '../conversations/adapters/codex'
import { OpenCodeAdapter } from '../conversations/adapters/opencode'
import { PiAdapter } from '../conversations/adapters/pi'

declare const __CLAVE_BUILTIN_REVISION__: string
// The build hashes the implementation and its local dependencies. Unit tests use a
// deterministic revision; packaged builds must never use a product version as a pin.
if (typeof __CLAVE_BUILTIN_REVISION__ !== 'string' && process.env.NODE_ENV !== 'test')
  throw new Error(
    'Missing built-in provider revision; build the conversation runtime before launching'
  )
const revision =
  typeof __CLAVE_BUILTIN_REVISION__ === 'string' ? __CLAVE_BUILTIN_REVISION__ : 'test-builtins-v1'

export interface BuiltinPlugin extends InstalledRuntimePlugin {
  factory: AdapterFactory
}
const definitions = [
  { id: 'claude', name: 'Claude Code', Adapter: ClaudeAdapter },
  { id: 'codex', name: 'Codex', Adapter: CodexAdapter },
  { id: 'opencode', name: 'OpenCode', Adapter: OpenCodeAdapter },
  { id: 'pi', name: 'Pi', Adapter: PiAdapter }
]

export function builtinPlugins(): BuiltinPlugin[] {
  return definitions.map(({ id, name, Adapter }) => ({
    manifest: {
      apiVersion: 1,
      id: `builtin.${id}`,
      name,
      version: '1.0.0',
      provider: {
        id,
        name,
        entry: 'builtin.cjs',
        command: [id],
        capabilities: { permissions: id !== 'pi', questions: true, resume: true }
      },
      views: []
    },
    revision,
    enabled: true,
    builtin: true,
    factory: (launch, emit) => new Adapter(launch, emit)
  }))
}
