import type { CredentialStore } from '../machines/types'
import type { MachineResolver, DeepLink } from './deeplink'
import { deepLinkOf } from './deeplink'
import type { IncomingResponse } from './port'
import { interpretResponse, settleFromNotification, type SettleClient } from './respond'
import { ACTION_IDS } from './categories'

export async function handleResponse(
  response: IncomingResponse,
  ports: {
    readonly machines: MachineResolver
    readonly credentials: CredentialStore
    readonly client: (credential: { serverUrl: string; bearer: string }) => SettleClient
  }
): Promise<{ kind: 'ignored' | 'settled' | 'open'; link?: DeepLink }> {
  const intent = interpretResponse(response)
  if (!intent) return { kind: 'ignored' }
  const machine = await ports.machines.byServerId(intent.payload.serverId)
  if (!machine) return { kind: 'open', link: await deepLinkOf(intent.payload, ports.machines) }
  const credential = await ports.credentials.get(machine.machineId)
  if (!credential)
    return { kind: 'open', link: { kind: 'machines', reason: 'Pair this phone again.' } }
  if (intent.kind !== 'open') {
    const outcome = await settleFromNotification(intent, ports.client(credential))
    if (outcome.kind === 'settled' || outcome.kind === 'already-settled') return { kind: 'settled' }
    return { kind: 'open', link: await deepLinkOf(intent.payload, ports.machines, 'request') }
  }
  const actionNeedsForm = (Object.values(ACTION_IDS) as readonly string[]).includes(
    response.actionIdentifier
  )
  return {
    kind: 'open',
    link: await deepLinkOf(
      intent.payload,
      ports.machines,
      actionNeedsForm ? 'request' : 'conversation'
    )
  }
}
