/**
 * The controls every screen is made of, each the phone's reading of one
 * class of the desktop's `packages/ui/src/system.css` (named beside it):
 * the pane's ground, a settings card and its rows, a section title, the
 * muted badge, a status said in words, the status dot, the two text
 * buttons, the icon button, the field with its label, a notice, a callout,
 * the empty state, the ring spinner. Nothing here carries a literal colour:
 * every value reads the theme (`useTheme`) or the spec (`theme.ts`).
 */
import { Children, Fragment, useEffect, useState, type ReactNode } from 'react'
import {
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type PressableStateCallbackType,
  type StyleProp,
  type TextInputProps,
  type TextStyle,
  type ViewStyle
} from 'react-native'
import { Icon, type IconName } from './Icon'
import {
  chatGlyph,
  control,
  controlSm,
  field,
  gutter,
  radius,
  space,
  text,
  type,
  useTheme,
  withAlpha
} from './theme'

/** `.chat-host` / a pane: the app's ground is surface-0, the card the desktop
 *  draws every view on. */
export function Screen({
  children,
  style,
  testID
}: {
  children: ReactNode
  style?: StyleProp<ViewStyle>
  testID?: string
}): ReactNode {
  const t = useTheme()
  return (
    <View style={[styles.screen, { backgroundColor: t.colors.surface0 }, style]} testID={testID}>
      {children}
    </View>
  )
}

/** `.settings-section-title` and `-description`: the title one step above
 *  the control label, with room for a glyph, the description under it. */
export function SectionTitle({
  title,
  description,
  icon
}: {
  title: string
  description?: string
  icon?: IconName
}): ReactNode {
  const t = useTheme()
  return (
    <View style={styles.sectionHead}>
      <View style={styles.sectionTitleRow}>
        {icon ? <Icon name={icon} size={14} color={t.colors.textSecondary} /> : null}
        <Text style={[type(text.control + 2), { color: t.colors.textPrimary }]}>{title}</Text>
      </View>
      {description ? (
        <Text style={[type(text.xs, 400, 1.5), { color: t.colors.textSecondary, marginTop: 2 }]}>
          {description}
        </Text>
      ) : null}
    </View>
  )
}

/** `.settings-card`: the page ground outlined, rows seamed by the subtle border. */
export function Card({
  children,
  style,
  testID
}: {
  children: ReactNode
  style?: StyleProp<ViewStyle>
  testID?: string
}): ReactNode {
  const t = useTheme()
  const rows = Children.toArray(children).filter(Boolean)
  return (
    <View
      style={[styles.card, { borderColor: t.colors.border }, style]}
      testID={testID}
      accessibilityRole="list"
    >
      {rows.map((row, index) => (
        <Fragment key={index}>
          {index > 0 ? (
            <View style={[styles.seam, { backgroundColor: t.colors.borderSubtle }]} />
          ) : null}
          {row}
        </Fragment>
      ))}
    </View>
  )
}

/** `.settings-row`: the text block left, the controls right; pressed, it
 *  takes the menu row's hover fill. A `leading` glyph sits where a settings
 *  section's does; `chevron` says the row opens somewhere, a phone's own
 *  affordance. */
export function Row({
  title,
  description,
  leading,
  controls,
  chevron,
  onPress,
  onLongPress,
  disabled,
  testID,
  accessibilityLabel
}: {
  title: string
  description?: string
  leading?: ReactNode
  controls?: ReactNode
  chevron?: boolean
  onPress?: () => void
  onLongPress?: () => void
  disabled?: boolean
  testID?: string
  accessibilityLabel?: string
}): ReactNode {
  const t = useTheme()
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={!onPress || disabled}
      testID={testID}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => [
        styles.row,
        pressed && onPress ? { backgroundColor: t.colors.surface100 } : null,
        disabled ? styles.disabled : null
      ]}
    >
      {leading ? <View style={styles.rowLeading}>{leading}</View> : null}
      <View style={styles.rowText}>
        <Text style={[type(text.control), { color: t.colors.textPrimary }]} numberOfLines={2}>
          {title}
        </Text>
        {description ? (
          <Text
            style={[type(text.xs, 400, 1.5), { color: t.colors.textTertiary, marginTop: 2 }]}
            numberOfLines={2}
          >
            {description}
          </Text>
        ) : null}
      </View>
      {controls ? <View style={styles.rowControls}>{controls}</View> : null}
      {chevron ? (
        <Icon name="chevron-right" size={control.icon} color={t.colors.textTertiary} />
      ) : null}
    </Pressable>
  )
}

/** `.settings-row-value`: a value a row only states, tabular. */
export function RowValue({
  children,
  testID
}: {
  children: ReactNode
  testID?: string
}): ReactNode {
  const t = useTheme()
  return (
    <Text
      style={[type(text.control), styles.tabular, { color: t.colors.textSecondary }]}
      numberOfLines={1}
      testID={testID}
    >
      {children}
    </Text>
  )
}

/** `.badge.badge-muted`: a quiet fact beside a title. */
export function Badge({ children, testID }: { children: ReactNode; testID?: string }): ReactNode {
  const t = useTheme()
  return (
    <View style={[styles.badge, { backgroundColor: t.colors.surface200 }]} testID={testID}>
      <Text style={[type(text.badge), { color: t.colors.textTertiary }]}>{children}</Text>
    </View>
  )
}

export type Status = 'connected' | 'connecting' | 'error' | 'neutral'

/** `.status-text[data-status]`: a status said in words at the end of a row. */
export function StatusText({
  status,
  children,
  testID
}: {
  status: Status
  children: ReactNode
  testID?: string
}): ReactNode {
  const t = useTheme()
  const color =
    status === 'connected'
      ? t.colors.success
      : status === 'connecting'
        ? t.colors.warning
        : status === 'error'
          ? t.colors.destructive
          : t.colors.textTertiary
  return (
    <Text style={[type(text.xs), { color }]} testID={testID} numberOfLines={1}>
      {children}
    </Text>
  )
}

export type DotStatus = 'working' | 'ready' | 'waiting' | 'inactive' | 'background'

/** `.pane-status-dot`: the session's state as the sidebar and the pane header
 *  show it, working pulsing in the accent blue. */
export function StatusDot({ status, size = 6 }: { status: DotStatus; size?: number }): ReactNode {
  const t = useTheme()
  const [pulse] = useState(() => new Animated.Value(1))
  const animated = status === 'working' || status === 'background'
  useEffect(() => {
    if (!animated) {
      pulse.setValue(1)
      return
    }
    const period = status === 'working' ? 2500 : 5000
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 0.4,
          duration: period / 2,
          easing: Easing.bezier(0.4, 0, 0.6, 1),
          useNativeDriver: true
        }),
        Animated.timing(pulse, {
          toValue: 1,
          duration: period / 2,
          easing: Easing.bezier(0.4, 0, 0.6, 1),
          useNativeDriver: true
        })
      ])
    )
    loop.start()
    return () => loop.stop()
  }, [animated, status, pulse])
  const color =
    status === 'working' || status === 'background'
      ? t.colors.statusWorking
      : status === 'ready'
        ? t.colors.statusReady
        : status === 'waiting'
          ? t.colors.statusWaiting
          : t.colors.statusInactive
  return (
    <Animated.View
      style={{
        width: size,
        height: size,
        borderRadius: size,
        backgroundColor: color,
        opacity: pulse
      }}
    />
  )
}

const pressDip = ({ pressed }: PressableStateCallbackType): ViewStyle =>
  pressed ? { transform: [{ scale: 0.97 }] } : {}

/** `.btn-primary` (the verb in the action ink) and `.btn-secondary` (the
 *  raised neutral partner: the raised surface with a hairline edge). `compact`
 *  is `.btn-compact`, one size down. */
export function Button({
  title,
  onPress,
  kind = 'primary',
  compact,
  icon,
  disabled,
  testID,
  style
}: {
  title: string
  onPress: () => void
  kind?: 'primary' | 'secondary'
  compact?: boolean
  icon?: IconName
  disabled?: boolean
  testID?: string
  style?: StyleProp<ViewStyle>
}): ReactNode {
  const t = useTheme()
  const spec = compact ? controlSm : control
  const ink = kind === 'primary' ? t.colors.actionForeground : t.colors.textPrimary
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled: !!disabled }}
      style={(state) => [
        styles.button,
        {
          height: spec.h,
          paddingHorizontal: kind === 'primary' ? spec.px * 2 : spec.px * 1.5,
          borderRadius: spec.radius,
          gap: control.gap
        },
        kind === 'primary'
          ? { backgroundColor: state.pressed ? t.colors.actionHover : t.colors.action }
          : {
              backgroundColor: state.pressed ? t.colors.surface100 : t.colors.surfaceRaised,
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: t.colors.edge
            },
        kind === 'secondary' ? t.raised : null,
        disabled ? styles.disabled : pressDip(state),
        style
      ]}
    >
      {icon ? <Icon name={icon} size={spec.icon} color={ink} /> : null}
      <Text style={[type(spec.text), { color: ink }]} numberOfLines={1}>
        {title}
      </Text>
    </Pressable>
  )
}

/** `.btn-icon`: a fixed square, the glyph tertiary at rest and primary
 *  on a press over the surface-200 fill; `danger` turns the ink destructive. */
export function IconButton({
  name,
  onPress,
  label,
  size = 'md',
  disabled,
  danger,
  active,
  testID
}: {
  name: IconName
  onPress: () => void
  label: string
  size?: 'md' | 'sm'
  disabled?: boolean
  danger?: boolean
  active?: boolean
  testID?: string
}): ReactNode {
  const t = useTheme()
  const spec = size === 'md' ? control : controlSm
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled, selected: !!active }}
      hitSlop={4}
      style={(state) => [
        styles.iconButton,
        { width: spec.h, height: spec.h, borderRadius: spec.radius },
        state.pressed && !disabled ? { backgroundColor: t.colors.surface200 } : null,
        active ? { backgroundColor: withAlpha(t.colors.accent, 0.12) } : null,
        disabled ? styles.disabled : pressDip(state)
      ]}
    >
      {({ pressed }) => (
        <Icon
          name={name}
          size={spec.icon}
          color={
            active
              ? t.colors.accent
              : pressed && !disabled
                ? danger
                  ? t.colors.destructive
                  : t.colors.textPrimary
                : t.colors.textTertiary
          }
        />
      )}
    </Pressable>
  )
}

/** `.field-label` over an `.input-field` (`.textarea-field` when multiline):
 *  the surface-100 fill, the subtle border, the accent border on focus. */
export function Field(
  props: TextInputProps & { label?: string; hint?: string; style?: StyleProp<TextStyle> }
): ReactNode {
  const t = useTheme()
  const { label, hint, style, multiline, onFocus, onBlur, ...rest } = props
  const [focused, setFocused] = useState(false)
  return (
    <View style={styles.field}>
      {label ? (
        <Text style={[type(text.xs), { color: t.colors.textSecondary, marginBottom: 6 }]}>
          {label}
        </Text>
      ) : null}
      <TextInput
        placeholderTextColor={t.colors.textTertiary}
        autoCapitalize="none"
        autoCorrect={false}
        multiline={multiline}
        {...rest}
        onFocus={(e) => {
          setFocused(true)
          onFocus?.(e)
        }}
        onBlur={(e) => {
          setFocused(false)
          onBlur?.(e)
        }}
        style={[
          type(field.text),
          styles.input,
          multiline ? styles.inputMultiline : { height: field.h },
          {
            color: t.colors.textPrimary,
            backgroundColor: t.colors.surface100,
            borderColor: focused ? t.colors.accent : t.colors.borderSubtle
          },
          style
        ]}
      />
      {hint ? (
        <Text style={[type(text.xs, 400, 1.5), { color: t.colors.textTertiary, marginTop: 6 }]}>
          {hint}
        </Text>
      ) : null}
    </View>
  )
}

/** `.chat-notice`: small and grey in the column's centre; the error tone
 *  carries the destructive ink and a hairline so it reads as what it is. */
export function Notice({
  children,
  tone,
  action,
  testID,
  style
}: {
  children: ReactNode
  tone?: 'error'
  action?: { label: string; onPress: () => void }
  testID?: string
  style?: StyleProp<ViewStyle>
}): ReactNode {
  const t = useTheme()
  if (tone === 'error')
    return (
      <View
        style={[
          styles.noticeError,
          { borderColor: withAlpha(t.colors.destructive, 0.4), borderRadius: radius.lg },
          style
        ]}
        testID={testID}
        accessibilityRole="alert"
      >
        <Text style={[type(text.control, 400, 1.5), { color: t.colors.destructive }]}>
          {children}
        </Text>
        {action ? (
          <Pressable onPress={action.onPress} accessibilityRole="button" hitSlop={6}>
            <Text
              style={[
                type(text.control, 400, 1.5),
                { color: t.colors.destructive, textDecorationLine: 'underline', marginTop: 4 }
              ]}
            >
              {action.label}
            </Text>
          </Pressable>
        ) : null}
      </View>
    )
  return (
    <View style={[styles.notice, style]} testID={testID} accessibilityRole="text">
      <Text
        style={[type(text.xs, 400, 1.5), { color: t.colors.textTertiary, textAlign: 'center' }]}
      >
        {children}
        {action ? (
          <Text
            onPress={action.onPress}
            style={{ color: t.colors.textPrimary, textDecorationLine: 'underline' }}
            accessibilityRole="button"
          >
            {' '}
            {action.label}
          </Text>
        ) : null}
      </Text>
    </View>
  )
}

/** `.settings-callout`: a confirmation, a picker, a notice under a card, the
 *  tone on the border only; its actions right-aligned on the control ramp. */
export function Callout({
  title,
  children,
  tone,
  actions,
  testID
}: {
  title?: string
  children?: ReactNode
  tone?: 'danger' | 'accent'
  actions?: ReactNode
  testID?: string
}): ReactNode {
  const t = useTheme()
  const border =
    tone === 'danger'
      ? withAlpha(t.colors.destructive, 0.45)
      : tone === 'accent'
        ? withAlpha(t.colors.accent, 0.45)
        : t.colors.border
  return (
    <View
      style={[styles.callout, { borderColor: border, backgroundColor: t.colors.surface50 }]}
      testID={testID}
    >
      {title ? (
        <Text style={[type(text.control), { color: t.colors.textPrimary }]}>{title}</Text>
      ) : null}
      {typeof children === 'string' ? (
        <Text
          style={[
            type(text.xs, 400, 1.5),
            { color: t.colors.textSecondary, marginTop: title ? 2 : 0 }
          ]}
        >
          {children}
        </Text>
      ) : (
        children
      )}
      {actions ? <View style={styles.calloutActions}>{actions}</View> : null}
    </View>
  )
}

/** `.chat-empty`: the icon on its tile, a title, a line under it. */
export function EmptyState({
  icon,
  title,
  text: body,
  action,
  testID
}: {
  icon: IconName
  title: string
  text?: string
  action?: ReactNode
  testID?: string
}): ReactNode {
  const t = useTheme()
  return (
    <View style={styles.empty} testID={testID}>
      <View style={[styles.emptyIcon, { backgroundColor: t.colors.surface100 }]}>
        <Icon name={icon} size={22} color={t.colors.textTertiary} />
      </View>
      <View style={{ gap: 2, alignItems: 'center' }}>
        <Text style={[type(text.sm), { color: t.colors.textPrimary, textAlign: 'center' }]}>
          {title}
        </Text>
        {body ? (
          <Text
            style={[type(text.xs, 400, 1.5), { color: t.colors.textTertiary, textAlign: 'center' }]}
          >
            {body}
          </Text>
        ) : null}
      </View>
      {action}
    </View>
  )
}

/** The sidebar's working ring (`.pane-search-spinner`): a ring of the ink at
 *  a fifth, one arc at full, turning. */
export function Spinner({
  size = 14,
  color,
  style
}: {
  size?: number
  color?: string
  style?: StyleProp<ViewStyle>
}): ReactNode {
  const t = useTheme()
  const [spin] = useState(() => new Animated.Value(0))
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(spin, {
        toValue: 1,
        duration: 700,
        easing: Easing.linear,
        useNativeDriver: true
      })
    )
    loop.start()
    return () => loop.stop()
  }, [spin])
  const ink = color ?? t.colors.textTertiary
  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] })
  return (
    <Animated.View
      accessibilityRole="progressbar"
      style={[
        {
          width: size,
          height: size,
          borderRadius: size,
          borderWidth: 1.5,
          borderColor: withAlpha(ink, 0.2),
          borderTopColor: ink,
          transform: [{ rotate }]
        },
        style
      ]}
    />
  )
}

/** A spinner centred in a list's empty slot, with the empty state's air. */
export function Loading({ testID }: { testID?: string }): ReactNode {
  return (
    <View style={styles.loading} testID={testID}>
      <Spinner />
    </View>
  )
}

/** `.chat-prompt-btn`: the prompt dock's button, one size down, raised; the
 *  primary one is the verb and wears the ink. */
export function PromptButton({
  title,
  onPress,
  primary,
  disabled,
  testID
}: {
  title: string
  onPress: () => void
  primary?: boolean
  disabled?: boolean
  testID?: string
}): ReactNode {
  const t = useTheme()
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled: !!disabled }}
      style={(state) => [
        styles.promptButton,
        {
          height: controlSm.h,
          paddingHorizontal: control.px * 1.25,
          borderRadius: control.radius,
          borderColor: primary ? t.colors.action : t.colors.border,
          backgroundColor: primary
            ? state.pressed
              ? t.colors.actionHover
              : t.colors.action
            : state.pressed
              ? t.colors.surface100
              : t.colors.surfaceRaised
        },
        disabled ? styles.disabled : pressDip(state)
      ]}
    >
      <Text
        style={[
          type(text.xs),
          { color: primary ? t.colors.actionForeground : t.colors.textPrimary }
        ]}
        numberOfLines={1}
      >
        {title}
      </Text>
    </Pressable>
  )
}

/** `.chat-prompt-option`: one choice of a question, full width; picked, the
 *  firmer neutral edge and the surface-100 fill, the box or the tick carrying
 *  the choice, never a blue wash. */
export function OptionRow({
  label,
  hint,
  selected,
  multi,
  onPress,
  disabled,
  testID,
  children
}: {
  label: string
  hint?: string
  selected: boolean
  multi?: boolean
  onPress: () => void
  disabled?: boolean
  testID?: string
  children?: ReactNode
}): ReactNode {
  const t = useTheme()
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      testID={testID}
      accessibilityRole={multi ? 'checkbox' : 'radio'}
      accessibilityState={{ checked: selected, disabled: !!disabled }}
      style={({ pressed }) => [
        styles.option,
        {
          borderRadius: radius.lg,
          borderColor: selected ? t.colors.textTertiary : t.colors.borderSubtle,
          backgroundColor: selected
            ? t.colors.surface100
            : pressed
              ? t.colors.surface50
              : 'transparent'
        },
        disabled ? styles.disabled : null
      ]}
    >
      <View style={styles.optionLine}>
        {multi ? (
          <View
            style={[
              styles.optionBox,
              {
                borderRadius: radius.sm,
                borderColor: selected ? t.colors.textPrimary : t.colors.textTertiary,
                backgroundColor: selected ? t.colors.textPrimary : 'transparent'
              }
            ]}
          >
            {selected ? <Icon name="check" size={12} color={t.colors.surface0} /> : null}
          </View>
        ) : null}
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text style={[type(text.control, 400, 1.5), { color: t.colors.textPrimary }]}>
            {label}
          </Text>
          {hint ? (
            <Text style={[type(text.xs, 400, 1.5), { color: t.colors.textTertiary }]}>{hint}</Text>
          ) : null}
        </View>
        {selected && !multi ? (
          <Icon name="check" size={chatGlyph} color={t.colors.textPrimary} />
        ) : null}
      </View>
      {children}
    </Pressable>
  )
}

/** `.chat-prompt-other`: the field whose card body is the answer, no inner box. */
export function BareInput(props: TextInputProps & { style?: StyleProp<TextStyle> }): ReactNode {
  const t = useTheme()
  const { style, ...rest } = props
  return (
    <TextInput
      placeholderTextColor={t.colors.textTertiary}
      autoCapitalize="sentences"
      {...rest}
      style={[type(text.xs, 400, 1.5), styles.bareInput, { color: t.colors.textPrimary }, style]}
    />
  )
}

/** A hairline between blocks (`--rule-color`). */
export function Rule({ style }: { style?: StyleProp<ViewStyle> }): ReactNode {
  const t = useTheme()
  return (
    <View style={[{ height: StyleSheet.hairlineWidth, backgroundColor: t.colors.rule }, style]} />
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  sectionHead: { marginBottom: 10, paddingHorizontal: gutter },
  sectionTitleRow: { flexDirection: 'row', alignItems: 'center', gap: space(2) },
  card: { borderWidth: 1, borderRadius: radius.xl, overflow: 'hidden', marginHorizontal: gutter },
  seam: { height: 1 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space(4),
    minHeight: 52,
    paddingVertical: 14,
    paddingHorizontal: 16
  },
  rowLeading: { width: control.icon, alignItems: 'center' },
  rowText: { flex: 1, minWidth: 0 },
  rowControls: { flexDirection: 'row', alignItems: 'center', gap: control.gap, flexShrink: 0 },
  tabular: { fontVariant: ['tabular-nums'] },
  badge: {
    alignSelf: 'flex-start',
    paddingVertical: 2,
    paddingHorizontal: 6,
    borderRadius: radius.full
  },
  button: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  iconButton: { alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  disabled: { opacity: 0.4 },
  field: { alignSelf: 'stretch' },
  input: {
    paddingHorizontal: field.px,
    paddingVertical: 0,
    borderRadius: field.radius,
    borderWidth: 1
  },
  inputMultiline: { paddingVertical: 8, minHeight: field.h * 2, textAlignVertical: 'top' },
  notice: {
    alignSelf: 'center',
    maxWidth: '100%',
    paddingVertical: space(1),
    paddingHorizontal: space(3)
  },
  noticeError: {
    alignSelf: 'stretch',
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderWidth: 1,
    marginHorizontal: gutter
  },
  callout: {
    padding: 12,
    paddingHorizontal: 14,
    borderRadius: radius.xl,
    borderWidth: 1,
    marginHorizontal: gutter
  },
  calloutActions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: control.gap,
    marginTop: 12
  },
  empty: {
    alignItems: 'center',
    gap: space(3),
    paddingVertical: space(8),
    paddingHorizontal: space(4)
  },
  emptyIcon: {
    width: space(12),
    height: space(12),
    borderRadius: radius.xxl,
    alignItems: 'center',
    justifyContent: 'center'
  },
  loading: { alignItems: 'center', padding: space(6) },
  promptButton: { alignItems: 'center', justifyContent: 'center', borderWidth: 1, flexShrink: 0 },
  option: { alignSelf: 'stretch', borderWidth: 1, paddingVertical: 7, paddingHorizontal: 10 },
  optionLine: { flexDirection: 'row', alignItems: 'center', gap: space(2) },
  optionBox: {
    width: 16,
    height: 16,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center'
  },
  bareInput: { padding: 0, margin: 0, minHeight: 18 }
})
