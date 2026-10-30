import Constants from 'expo-constants'
import * as Device from 'expo-device'
import { File } from 'expo-file-system'
import * as ImagePicker from 'expo-image-picker'
import * as DocumentPicker from 'expo-document-picker'
import * as Notifications from 'expo-notifications'
import { Platform } from 'react-native'
import { AuthError, type HubSignIn } from '../auth/sign-in'
import { ServerError } from '../api/errors'
import { Drafts, type KeyValueStore } from '../chat/drafts'
import { AttachmentClient } from '../attachments/client'
import { prepareAttachment, type Prepared } from '../attachments/compose'
import {
  pickDocuments,
  pickPhotos,
  takePhoto,
  type ImagePickerPort,
  type DocumentPickerPort
} from '../attachments/pickers'
import type { Attachment } from '../contract/types'
import { EnrollmentClient } from '../enroll/client'
import { pair, type PairingState } from '../enroll/pairing'
import { EnrollmentRecords } from '../enroll/records'
import { RelayMachineSource } from '../machines/relay'
import type { CredentialStore, Machine, MachineSource } from '../machines/types'
import { assertCredentialMayTravelTo, type BuildKind } from '../machines/transport-policy'
import { DeliveryController } from '../reconnect/controller'
import { DeliveryMarks, UnknownSends } from '../reconnect/ledger'
import { registerDeviceToken, pushTokenKey, type TokenRegistration } from '../notifications/token'
import type { DevicePushToken } from '../notifications/port'

export class BetaServices {
  private tokenSync: Promise<TokenRegistration[]> = Promise.resolve([])
  readonly records: EnrollmentRecords
  readonly delivery: DeliveryController
  readonly source: MachineSource
  constructor(
    readonly auth: HubSignIn,
    readonly kv: KeyValueStore,
    readonly credentials: CredentialStore,
    readonly drafts: Drafts,
    readonly build: BuildKind,
    private readonly assertOwner: () => void = auth.guardAccount()
  ) {
    this.records = new EnrollmentRecords(kv)
    this.delivery = new DeliveryController(new UnknownSends(kv), new DeliveryMarks(kv), drafts, kv)
    this.source = { list: () => this.machines() }
  }

  async relayUrl(): Promise<string> {
    return (
      (await this.kv.getItem('relay-url')) ??
      String(Constants.expoConfig?.extra?.mobileRelayUrl ?? '')
    )
  }

  async setRelayUrl(value: string): Promise<void> {
    const url = value.trim().replace(/\/+$/, '')
    const parsed = new URL(url)
    assertCredentialMayTravelTo(url, this.build)
    if (parsed.pathname !== '/' || parsed.search || parsed.hash)
      throw new Error('Enter the team relay origin without a path or query.')
    if (url !== (await this.relayUrl())) {
      for (const record of await this.records.list()) {
        await this.credentials.remove(record.machineId)
        await this.records.remove(record.machineId)
      }
      await this.kv.removeItem('machines-cache')
    }
    await this.kv.setItem('relay-url', url)
  }

  private async machines(): Promise<Machine[]> {
    if (!this.auth.status().account) return []
    this.assertOwner()
    const relayUrl = await this.relayUrl()
    this.assertOwner()
    if (!relayUrl) throw new Error('Enter the team relay address to see your machines.')
    try {
      const machines = await new RelayMachineSource(
        relayUrl,
        () => {
          this.assertOwner()
          return this.auth.accessToken()
        },
        {
          build: this.build
        }
      ).list()
      this.assertOwner()
      await this.kv.setItem('machines-cache', JSON.stringify(machines))
      return machines
    } catch (error) {
      this.assertOwner()
      const transient =
        error instanceof ServerError
          ? ['network', 'timeout'].includes(error.kind) || (error.status ?? 0) >= 500
          : error instanceof AuthError && ['network', 'timeout'].includes(error.failure)
      if (!transient) throw error
      const raw = await this.kv.getItem('machines-cache')
      if (!raw) throw error
      const cached: unknown = JSON.parse(raw)
      if (!Array.isArray(cached)) throw error
      return (cached as Machine[]).map((machine) => ({ ...machine, online: false }))
    }
  }

  async pair(
    machine: Machine,
    onState: (state: PairingState) => void,
    cancelled: () => boolean
  ): Promise<PairingState> {
    this.assertOwner()
    const idToken = await this.auth.idToken()
    this.assertOwner()
    const clientId = await this.auth.ensureClient()
    this.assertOwner()
    const result = await pair(
      {
        machine,
        idToken,
        clientId,
        device: {
          name: Device.deviceName ?? (Platform.OS === 'ios' ? 'iPhone' : 'Android phone'),
          platform: Platform.OS === 'ios' ? 'ios' : 'android',
          appVersion: Constants.expoConfig?.version ?? '0.1.0'
        }
      },
      {
        client: new EnrollmentClient(machine.baseUrl, { build: this.build }),
        credentials: this.credentials,
        records: this.records,
        onState,
        cancelled: () => {
          try {
            this.assertOwner()
          } catch {
            return true
          }
          return cancelled()
        },
        now: Date.now,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
      }
    )
    if (result.kind === 'approved') await this.kv.removeItem(pushTokenKey(machine.id))
    return result
  }

  async registerPush(
    machineId: string,
    token?: DevicePushToken,
    requestPermission = true
  ): Promise<TokenRegistration> {
    const credential = await this.credentials.get(machineId)
    if (!credential) return { kind: 'failed', reason: 'Pair this phone first.' }
    const permission = requestPermission
      ? await Notifications.requestPermissionsAsync()
      : await Notifications.getPermissionsAsync()
    if (!permission.granted)
      return { kind: 'unsupported', reason: 'Notifications are off for Clave.' }
    return registerDeviceToken(
      { machineId, bearer: credential.bearer, platform: Platform.OS === 'ios' ? 'ios' : 'android' },
      {
        notifications: token ? { getDevicePushTokenAsync: async () => token } : Notifications,
        kv: this.kv,
        client: new EnrollmentClient(credential.serverUrl, { build: this.build })
      }
    )
  }

  /** Boot and native token rotation keep every paired server's raw token current. */
  syncPushTokens(token?: DevicePushToken): Promise<TokenRegistration[]> {
    const run = this.tokenSync.then(async () => {
      const outcomes: TokenRegistration[] = []
      for (const record of await this.records.list())
        outcomes.push(await this.registerPush(record.machineId, token, false))
      return outcomes
    })
    this.tokenSync = run.catch(() => [])
    return run
  }

  async attach(
    kind: 'photos' | 'camera' | 'files',
    machineId: string,
    sessionId: string,
    current: readonly Attachment[],
    imagesSupported: boolean
  ): Promise<Prepared[]> {
    const credential = await this.credentials.get(machineId)
    if (!credential) return [{ ok: false, reason: 'Pair this phone first.' }]
    if (kind === 'camera') {
      const permission = await ImagePicker.requestCameraPermissionsAsync()
      if (!permission.granted)
        return [{ ok: false, reason: 'Allow camera access to take a photo.' }]
    }
    const imagePicker: ImagePickerPort = {
      launchCameraAsync: (options) =>
        ImagePicker.launchCameraAsync({ ...options, mediaTypes: [...options.mediaTypes] }),
      launchImageLibraryAsync: (options) =>
        ImagePicker.launchImageLibraryAsync({ ...options, mediaTypes: [...options.mediaTypes] })
    }
    const documentPicker: DocumentPickerPort = {
      getDocumentAsync: (options) =>
        DocumentPicker.getDocumentAsync({
          ...options,
          type:
            typeof options.type === 'string'
              ? options.type
              : options.type
                ? [...options.type]
                : undefined
        })
    }
    const picked =
      kind === 'files'
        ? await pickDocuments(documentPicker, 10 - current.length)
        : kind === 'camera'
          ? await takePhoto(imagePicker)
          : await pickPhotos(imagePicker, 10 - current.length)
    const result: Prepared[] = []
    const attached = [...current]
    for (const file of picked ?? []) {
      const prepared = await prepareAttachment(
        file,
        sessionId,
        attached,
        {
          client: new AttachmentClient(credential, { build: this.build }),
          reader: { readBase64: (uri) => new File(uri).base64() }
        },
        { filesRoute: true, imagesSupported }
      )
      result.push(prepared)
      if (prepared.ok) attached.push(prepared.record)
    }
    return result
  }
}
