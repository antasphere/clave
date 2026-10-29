/**
 * The platform's own pickers behind two interfaces (decision 11 of the
 * spec): expo-image-picker for a photo or a screenshot from the library and
 * a shot from the camera, expo-document-picker for a file. The shapes
 * mirror the modules' results (`ImagePicker.types.d.ts`,
 * `expo-document-picker/build/types.d.ts`, the SDK 58 line) so the wiring
 * passes the modules through; the tests hand stubs. A cancelled picker is
 * null, never an empty list: the composer tells the two apart.
 */
import { kindOf, mimeTypeOf, type PickedFile } from './types'

export interface ImagePickerAsset {
  readonly uri: string
  readonly width: number
  readonly height: number
  readonly type?: 'image' | 'video' | 'livePhoto' | 'pairedVideo' | null
  readonly fileName?: string | null
  readonly fileSize?: number
  readonly mimeType?: string
}

export interface ImagePickerResult {
  readonly canceled: boolean
  readonly assets?: readonly ImagePickerAsset[] | null
}

export interface ImagePickerOptions {
  readonly mediaTypes: readonly ('images' | 'videos')[]
  readonly allowsMultipleSelection?: boolean
  readonly selectionLimit?: number
  /** 0 to 1; below 1 the platform re-encodes a photo as JPEG. */
  readonly quality?: number
}

export interface ImagePickerPort {
  launchImageLibraryAsync(options: ImagePickerOptions): Promise<ImagePickerResult>
  launchCameraAsync(options: ImagePickerOptions): Promise<ImagePickerResult>
}

export interface DocumentPickerAsset {
  readonly uri: string
  readonly name: string
  readonly size?: number
  readonly mimeType?: string
}

export interface DocumentPickerResult {
  readonly canceled: boolean
  readonly assets?: readonly DocumentPickerAsset[] | null
}

export interface DocumentPickerPort {
  getDocumentAsync(options: {
    readonly type?: string | readonly string[]
    readonly multiple?: boolean
    readonly copyToCacheDirectory?: boolean
  }): Promise<DocumentPickerResult>
}

const nameOf = (uri: string, fallback: string): string => {
  const last = uri.split('?')[0]!.split('/').pop() ?? ''
  return decodeURIComponent(last) || fallback
}

export function pickedFromImageAssets(assets: readonly ImagePickerAsset[]): PickedFile[] {
  return assets.map((asset, index) => {
    const video = asset.type === 'video' || asset.type === 'pairedVideo'
    const name =
      asset.fileName ||
      nameOf(asset.uri, video ? `Video ${index + 1}.mov` : `Photo ${index + 1}.jpg`)
    const mimeType = asset.mimeType || mimeTypeOf(name)
    return {
      uri: asset.uri,
      name,
      mimeType,
      size: typeof asset.fileSize === 'number' ? asset.fileSize : null,
      kind: video ? 'video' : kindOf(mimeType)
    }
  })
}

export function pickedFromDocumentAssets(assets: readonly DocumentPickerAsset[]): PickedFile[] {
  return assets.map((asset) => {
    const name = asset.name || nameOf(asset.uri, 'File')
    const mimeType = asset.mimeType || mimeTypeOf(name)
    return {
      uri: asset.uri,
      name,
      mimeType,
      size: typeof asset.size === 'number' ? asset.size : null,
      kind: kindOf(mimeType)
    }
  })
}

/** Photos and screenshots from the library; null when the person cancelled. */
export async function pickPhotos(
  port: Pick<ImagePickerPort, 'launchImageLibraryAsync'>,
  limit: number
): Promise<PickedFile[] | null> {
  const result = await port.launchImageLibraryAsync({
    mediaTypes: ['images', 'videos'],
    allowsMultipleSelection: limit > 1,
    selectionLimit: limit,
    quality: 1
  })
  if (result.canceled || !result.assets) return null
  return pickedFromImageAssets(result.assets)
}

/** One shot from the camera; null when the person cancelled. */
export async function takePhoto(
  port: Pick<ImagePickerPort, 'launchCameraAsync'>
): Promise<PickedFile[] | null> {
  const result = await port.launchCameraAsync({ mediaTypes: ['images'], quality: 1 })
  if (result.canceled || !result.assets) return null
  return pickedFromImageAssets(result.assets)
}

/** Files from the document picker; null when the person cancelled. */
export async function pickDocuments(
  port: DocumentPickerPort,
  limit: number
): Promise<PickedFile[] | null> {
  const result = await port.getDocumentAsync({
    type: '*/*',
    multiple: limit > 1,
    copyToCacheDirectory: true
  })
  if (result.canceled || !result.assets) return null
  return pickedFromDocumentAssets(result.assets)
}
