/** The devices group of the HTTP API implemented, every endpoint of
 *  `@clave/contract/devices` through the CQRS bridge. */
import * as HttpApiBuilder from '@effect/platform/HttpApiBuilder'
import { HttpCqrs } from '@structure-ai/http'
import { ClaveApi } from '@clave/contract/api'
import * as D from '@clave/contract/devices'

export const DevicesLive = HttpApiBuilder.group(ClaveApi, 'devices', (handlers) =>
  handlers
    .handle('requestPairing', HttpCqrs.command(D.RequestDevicePairing))
    .handle('readPairing', HttpCqrs.query(D.ReadDevicePairing))
    .handle('list', HttpCqrs.query(D.ListDevices))
    .handle('approve', HttpCqrs.command(D.ApproveDevicePairing))
    .handle('refuse', HttpCqrs.command(D.RefuseDevicePairing))
    .handle('revoke', HttpCqrs.command(D.RevokeDevice))
    .handle('me', HttpCqrs.query(D.ReadOwnDevice))
    .handle('setPushToken', HttpCqrs.command(D.SetDevicePushToken))
    .handle('clearPushToken', HttpCqrs.command(D.ClearDevicePushToken))
    .handle('readRelay', HttpCqrs.query(D.ReadMobileRelay))
    .handle('setRelay', HttpCqrs.command(D.SetMobileRelay))
)
