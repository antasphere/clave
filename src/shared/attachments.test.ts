import { expect, test } from 'vitest'
import {
  AttachmentSchema,
  attachmentKind,
  insertMarker,
  markerOf,
  nextLabel,
  reconcileAttachments,
  removeMarker,
  type Attachment
} from './attachments'

const image: Attachment = {
  id: 'a',
  label: 'Image #1',
  path: '/tmp/a.png',
  name: 'a.png',
  mimeType: 'image/png',
  size: 1,
  delivery: 'image'
}
const heic: Attachment = {
  id: 'b',
  label: 'File #1',
  path: '/tmp/b.heic',
  name: 'b.heic',
  mimeType: 'image/heic',
  size: 1,
  delivery: 'reference'
}
const tab: Attachment = {
  id: 'c',
  label: 'Session #1',
  delivery: 'session',
  sessionId: 'sess-1',
  name: 'Lane A',
  agent: 'Claude Code',
  cwd: '/work/a'
}

test('a session record is an attachment, a file record stays one, and labels are optional', () => {
  expect(AttachmentSchema.parse(tab)).toEqual(tab)
  expect(AttachmentSchema.parse(image)).toEqual(image)
  const unlabelled = { ...image, label: undefined }
  expect(AttachmentSchema.parse(unlabelled)).toEqual(unlabelled)
  expect(() => AttachmentSchema.parse({ ...tab, sessionId: 'not a/session' })).toThrow()
  expect(() => AttachmentSchema.parse({ ...tab, path: '/x' })).toThrow()
})

test('a record is labelled by what it is to the agent: an image sent as a path is a File', () => {
  expect(attachmentKind(image)).toBe('Image')
  expect(attachmentKind(heic)).toBe('File')
  expect(attachmentKind(tab)).toBe('Session')
})

test('labels number per kind, one past the highest in the message', () => {
  expect(nextLabel('Image', [])).toBe('Image #1')
  expect(nextLabel('Image', [image, heic, tab])).toBe('Image #2')
  expect(nextLabel('File', [image, heic, tab])).toBe('File #2')
  expect(nextLabel('Session', [image, { ...tab, label: 'Session #4' }])).toBe('Session #5')
  // A removed number is not reissued while a higher one stands: the text may
  // still hold the old marker's remains.
  expect(nextLabel('Image', [{ ...image, label: 'Image #3' }])).toBe('Image #4')
  expect(markerOf(tab)).toBe('[Session #1]')
  expect(markerOf({ label: undefined })).toBeUndefined()
})

test('a marker is inserted spaced from its neighbours and followed by a space', () => {
  expect(insertMarker('', '[Image #1]', 0)).toEqual({ text: '[Image #1] ', caret: 11 })
  expect(insertMarker('look at', '[Image #1]', 7)).toEqual({
    text: 'look at [Image #1] ',
    caret: 19
  })
  expect(insertMarker('look at this', '[Image #1]', 7)).toEqual({
    text: 'look at [Image #1] this',
    caret: 19
  })
  expect(insertMarker('a  b', '[File #1]', 2)).toEqual({ text: 'a [File #1] b', caret: 12 })
  // An index past the end lands at the end.
  expect(insertMarker('x', '[File #1]', 99).text).toBe('x [File #1] ')
})

test('removing a marker closes the words up around it', () => {
  expect(removeMarker('look at [Image #1] this', '[Image #1]')).toBe('look at this')
  expect(removeMarker('[Image #1] [Image #1] x', '[Image #1]')).toBe('x')
  expect(removeMarker('nothing here', '[Image #1]')).toBe('nothing here')
})

test('a record whose marker left the text leaves the message; an unlabelled one stays', () => {
  const files = [image, heic, tab]
  expect(reconcileAttachments('[Image #1] [File #1] [Session #1]', files)).toEqual(files)
  expect(reconcileAttachments('[Image #1] [File #1] [Session #1', files)).toEqual([image, heic])
  expect(reconcileAttachments('', files)).toEqual([])
  const unlabelled: Attachment = { ...image, label: undefined }
  expect(reconcileAttachments('', [unlabelled, tab])).toEqual([unlabelled])
})
