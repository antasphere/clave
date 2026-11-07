/**
 * `.pane-header`: the one row at the top of every pane, terminal and chat
 * alike on the desktop, and of every screen here: the status dot, the
 * name, a quiet meta line, the pane's icon buttons on the right. It stands
 * where the native stack's header stood, one control tall plus the box's
 * inset. The app root owns the status bar's safe area, so the phone's chrome is the
 * desktop's rather than the platform's.
 */
import type { ReactNode } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { IconButton, StatusDot, type DotStatus } from './components'
import { control, space, text, type, useTheme } from './theme'

export function PaneHeader({
  title,
  meta,
  status,
  onBack,
  actions,
  testID
}: {
  title: string
  meta?: string
  status?: DotStatus | null
  onBack?: () => void
  actions?: ReactNode
  testID?: string
}): ReactNode {
  const t = useTheme()
  return (
    <View
      style={[
        styles.header,
        {
          backgroundColor: t.colors.surface0,
          borderBottomColor: t.colors.borderSubtle
        }
      ]}
      testID={testID}
    >
      <View style={styles.lead}>
        {onBack ? (
          <IconButton name="arrow-left" label="Back" onPress={onBack} testID="pane-back" />
        ) : null}
        {status !== undefined && status !== null ? (
          <View style={styles.dot}>
            <StatusDot status={status} />
          </View>
        ) : null}
        <View style={styles.titles}>
          <Text
            style={[type(text.control), { color: t.colors.textSecondary }]}
            numberOfLines={1}
            accessibilityRole="header"
          >
            {title}
          </Text>
          {meta ? (
            <Text style={[type(text.meta), { color: t.colors.textTertiary }]} numberOfLines={1}>
              {meta}
            </Text>
          ) : null}
        </View>
      </View>
      {actions ? <View style={styles.actions}>{actions}</View> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space(2),
    minHeight: control.h + space(2),
    paddingTop: space(1),
    paddingBottom: space(1),
    paddingHorizontal: space(2),
    borderBottomWidth: StyleSheet.hairlineWidth
  },
  lead: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: space(2) },
  dot: { width: control.icon, alignItems: 'center', justifyContent: 'center' },
  titles: { flex: 1, minWidth: 0, paddingLeft: space(1) },
  actions: { flexDirection: 'row', alignItems: 'center', gap: space(0.5), flexShrink: 0 }
})
