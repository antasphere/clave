/**
 * The handful of controls every screen is made of: a screen with its
 * padding, a row of a list, a pill for a state, a button for a verb, a text
 * field, the empty and error texts. Nothing clever; the theme does the rest.
 */
import type { ReactNode } from 'react'
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type ViewStyle
} from 'react-native'
import { colors, font, radius, space, toneColor, type Tone } from './theme'

export function Screen({
  children,
  style
}: {
  children: ReactNode
  style?: StyleProp<ViewStyle>
}): ReactNode {
  return <View style={[styles.screen, style]}>{children}</View>
}

export function Row({
  title,
  subtitle,
  right,
  onPress,
  testID,
  disabled
}: {
  title: string
  subtitle?: string
  right?: ReactNode
  onPress?: () => void
  testID?: string
  disabled?: boolean
}): ReactNode {
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress || disabled}
      testID={testID}
      accessibilityRole={onPress ? 'button' : undefined}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed, disabled && styles.dim]}
    >
      <View style={styles.rowText}>
        <Text style={styles.rowTitle} numberOfLines={2}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={styles.rowSubtitle} numberOfLines={2}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {right ? <View style={styles.rowRight}>{right}</View> : null}
    </Pressable>
  )
}

export function Pill({
  text,
  tone = 'neutral',
  testID
}: {
  text: string
  tone?: Tone
  testID?: string
}): ReactNode {
  const color = toneColor[tone]
  return (
    <View style={[styles.pill, { borderColor: color }]} testID={testID}>
      <Text style={[styles.pillText, { color }]}>{text}</Text>
    </View>
  )
}

export function Button({
  title,
  onPress,
  kind = 'primary',
  disabled,
  testID
}: {
  title: string
  onPress: () => void
  kind?: 'primary' | 'secondary' | 'danger'
  disabled?: boolean
  testID?: string
}): ReactNode {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={title}
      style={({ pressed }) => [
        styles.button,
        kind === 'primary' && styles.buttonPrimary,
        kind === 'secondary' && styles.buttonSecondary,
        kind === 'danger' && styles.buttonDanger,
        pressed && styles.dim,
        disabled && styles.dim
      ]}
    >
      <Text
        style={[
          styles.buttonText,
          kind === 'primary' && { color: colors.actionForeground },
          kind === 'secondary' && { color: colors.textPrimary },
          kind === 'danger' && { color: '#fff' }
        ]}
      >
        {title}
      </Text>
    </Pressable>
  )
}

export function Field(props: TextInputProps & { label?: string }): ReactNode {
  const { label, style, ...rest } = props
  return (
    <View style={styles.field}>
      {label ? <Text style={styles.label}>{label}</Text> : null}
      <TextInput
        placeholderTextColor={colors.textTertiary}
        autoCapitalize="none"
        autoCorrect={false}
        {...rest}
        style={[styles.input, style]}
      />
    </View>
  )
}

export function Muted({ children, testID }: { children: ReactNode; testID?: string }): ReactNode {
  return (
    <Text style={styles.muted} testID={testID}>
      {children}
    </Text>
  )
}

export function ErrorText({
  children,
  testID
}: {
  children: ReactNode
  testID?: string
}): ReactNode {
  return (
    <Text style={styles.error} testID={testID} accessibilityRole="alert">
      {children}
    </Text>
  )
}

export function Heading({ children }: { children: ReactNode }): ReactNode {
  return <Text style={styles.heading}>{children}</Text>
}

export function Spinner(): ReactNode {
  return (
    <View style={styles.spinner}>
      <ActivityIndicator color={colors.textSecondary} />
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.surface0 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
    gap: space.md
  },
  rowPressed: { backgroundColor: colors.surface100 },
  rowText: { flex: 1, gap: 2 },
  rowTitle: { color: colors.textPrimary, fontSize: font.md },
  rowSubtitle: { color: colors.textSecondary, fontSize: font.sm },
  rowRight: { alignItems: 'flex-end', gap: space.xs },
  pill: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: space.sm,
    paddingVertical: 2,
    alignSelf: 'flex-start'
  },
  pillText: { fontSize: font.xs, fontWeight: '600' },
  button: {
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center'
  },
  buttonPrimary: { backgroundColor: colors.action },
  buttonSecondary: {
    backgroundColor: colors.surface200,
    borderWidth: 1,
    borderColor: colors.border
  },
  buttonDanger: { backgroundColor: colors.destructive },
  buttonText: { fontSize: font.md, fontWeight: '600' },
  dim: { opacity: 0.6 },
  field: { gap: space.xs },
  label: { color: colors.textSecondary, fontSize: font.sm },
  input: {
    color: colors.textPrimary,
    backgroundColor: colors.surface100,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    fontSize: font.md
  },
  muted: { color: colors.textSecondary, fontSize: font.sm, padding: space.lg, textAlign: 'center' },
  error: {
    color: colors.destructive,
    fontSize: font.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm
  },
  heading: {
    color: colors.textSecondary,
    fontSize: font.xs,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
    paddingBottom: space.xs
  },
  spinner: { padding: space.lg, alignItems: 'center' }
})
