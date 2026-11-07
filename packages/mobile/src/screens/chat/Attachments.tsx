/**
 * The files on a message (`Attachments.tsx` on the desktop): in the
 * composer they sit above the field as chips that can still be removed; on
 * a sent turn they are the record of what went. A chip is the record's tile
 * (the family's glyph on a small tile) beside its name and a line under it.
 */
import type { ReactNode } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import type { Attachment } from '../../contract/types'
import { Icon, type IconName } from '../../ui/Icon'
import { IconButton } from '../../ui/components'
import { control, radius, space, text, type, useTheme, withAlpha } from '../../ui/theme'

const FAMILY: Record<string, { name: string; icon: IconName }> = {
  image: { name: 'Image', icon: 'photo' },
  folder: { name: 'Folder', icon: 'folder' },
  session: { name: 'Session', icon: 'chat-bubble-left-right' },
  file: { name: 'File', icon: 'document' }
}

const family = (file: Attachment): string =>
  file.delivery === 'session'
    ? 'session'
    : file.delivery === 'folder'
      ? 'folder'
      : file.mimeType.startsWith('image/')
        ? 'image'
        : 'file'

const sizeLabel = (bytes: number): string =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
      : `${(bytes / (1024 * 1024)).toFixed(1)} MB`

function describe(file: Attachment): string {
  if (file.delivery === 'session') return 'Session'
  const kind = FAMILY[family(file)]!.name
  const figure =
    file.delivery === 'folder'
      ? `${file.entries ?? 0} ${(file.entries ?? 0) === 1 ? 'item' : 'items'}`
      : sizeLabel(file.size)
  return `${kind} · ${figure}`
}

export function AttachmentChip({
  file,
  onRemove
}: {
  file: Attachment
  onRemove?: () => void
}): ReactNode {
  const t = useTheme()
  const kind = FAMILY[family(file)]!
  const name = file.delivery === 'session' ? (file.label ?? 'Session') : file.name
  return (
    <View
      style={[
        styles.chip,
        {
          backgroundColor: t.colors.surface100,
          borderColor: t.colors.borderSubtle,
          borderRadius: radius.xl
        },
        onRemove ? { paddingRight: space(1) } : null
      ]}
      accessibilityLabel={`${name}, ${describe(file)}`}
    >
      <View
        style={[
          styles.tile,
          { backgroundColor: withAlpha(t.colors.surface200, 0.7), borderRadius: control.radius }
        ]}
      >
        <Icon name={kind.icon} size={control.icon} color={t.colors.textTertiary} />
      </View>
      <View style={styles.text}>
        <Text style={[type(text.xs, 400, 1.4), { color: t.colors.textPrimary }]} numberOfLines={1}>
          {name}
        </Text>
        <Text
          style={[type(text.xs, 400, 1.4), { color: t.colors.textSecondary }]}
          numberOfLines={1}
        >
          {file.label ? (
            <Text style={[type(10), { color: t.colors.textSecondary, letterSpacing: 0.4 }]}>
              {`${file.label.toUpperCase()}  `}
            </Text>
          ) : null}
          {describe(file)}
        </Text>
      </View>
      {onRemove ? (
        <IconButton name="x-mark" size="sm" label={`Remove ${name}`} onPress={onRemove} />
      ) : null}
    </View>
  )
}

export function Attachments({
  files,
  onRemove,
  align
}: {
  files: readonly Attachment[]
  onRemove?: (id: string) => void
  align?: 'end'
}): ReactNode {
  if (!files.length) return null
  return (
    <View style={[styles.list, align === 'end' ? styles.listEnd : null]} accessibilityRole="list">
      {files.map((file) => (
        <AttachmentChip
          key={file.id}
          file={file}
          onRemove={onRemove ? () => onRemove(file.id) : undefined}
        />
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  list: { flexDirection: 'row', flexWrap: 'wrap', gap: space(1.5) },
  listEnd: { justifyContent: 'flex-end', maxWidth: '85%', alignSelf: 'flex-end' },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space(1),
    padding: space(1),
    borderWidth: 1,
    maxWidth: '100%'
  },
  tile: { width: control.h, height: control.h, alignItems: 'center', justifyContent: 'center' },
  text: {
    minWidth: 0,
    flexShrink: 1,
    paddingVertical: 2,
    paddingHorizontal: space(1),
    maxWidth: 200
  }
})
