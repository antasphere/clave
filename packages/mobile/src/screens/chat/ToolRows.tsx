/**
 * Tool rows, the way the desktop draws them (`ToolGroup.tsx`): every run of
 * calls is one line of muted text led by the icon of its kind, no frame; the
 * row opens to one row per call, and a call opens to its panel, the only
 * framed thing here: the command, file or change as code, and what came
 * back. A lone call is its own row and opens straight to its panel. The
 * words and the grouping are `chat/tools.ts`, the desktop's own module.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native'
import {
  describeTool,
  describeToolHead,
  failureCount,
  groupKind,
  groupStatus,
  safeJson,
  sectionLanguage,
  toolGroupSummary,
  toolPreview,
  toolVerb,
  type GroupStatus,
  type Section,
  type ToolEntry,
  type ToolGroup as Group,
  type ToolKind
} from '../../chat/tools'
import { Icon } from '../../ui/Icon'
import { KIND_ICONS } from './tool-icons'
import { chatGlyph, codeSize, radius, space, text, type, useTheme } from '../../ui/theme'
import { CodeBlock } from './Markdown'

const stringify = (value: unknown): string => (typeof value === 'string' ? value : safeJson(value))

/** `.chat-tool-status[data-running]`: the arrows turning. */
export function Spinning({ children }: { children: ReactNode }): ReactNode {
  const [spin] = useState(() => new Animated.Value(0))
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(spin, {
        toValue: 1,
        duration: 1000,
        easing: Easing.linear,
        useNativeDriver: true
      })
    )
    loop.start()
    return () => loop.stop()
  }, [spin])
  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] })
  return <Animated.View style={{ transform: [{ rotate }] }}>{children}</Animated.View>
}

/** The glyph a row opens with: its kind, unless something still runs (the
 *  spinner) or failed (the warning), which the reader needs more than the kind. */
function RowIcon({ kind, status }: { kind: ToolKind; status: GroupStatus }): ReactNode {
  const t = useTheme()
  if (status === 'running')
    return (
      <Spinning>
        <Icon name="arrow-path" size={chatGlyph} color={t.colors.textTertiary} />
      </Spinning>
    )
  if (status === 'failed')
    return <Icon name="exclamation-triangle" size={chatGlyph} color={t.colors.destructive} />
  return <Icon name={KIND_ICONS[kind]} size={chatGlyph} color={t.colors.textTertiary} />
}

/** `.chat-tool-row`: the icon, what was done, and the chevron that turns
 *  when the row opens. */
function RowSummary({
  kind,
  status,
  open,
  onPress,
  children,
  testID
}: {
  kind: ToolKind
  status: GroupStatus
  open: boolean
  onPress: () => void
  children: ReactNode
  testID?: string
}): ReactNode {
  const t = useTheme()
  return (
    <Pressable
      onPress={onPress}
      style={styles.row}
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      testID={testID}
    >
      <RowIcon kind={kind} status={status} />
      {children}
      <Icon
        name="chevron-right"
        size={chatGlyph}
        color={t.colors.textTertiary}
        style={{ transform: [{ rotate: open ? '90deg' : '0deg' }], opacity: open ? 1 : 0.6 }}
      />
    </Pressable>
  )
}

/** A preview shows the first lines; the rest is one tap away, per section. */
function Preview({
  section,
  prompt
}: {
  section: Section
  language?: string
  prompt?: boolean
}): ReactNode {
  const t = useTheme()
  const [full, setFull] = useState(false)
  const preview = toolPreview(section.text)
  return (
    <View style={styles.section}>
      <CodeBlock code={full ? section.text : preview.text} prompt={prompt} style="panel" />
      {preview.truncated ? (
        <Pressable
          onPress={() => setFull(!full)}
          accessibilityRole="button"
          hitSlop={6}
          style={{ alignSelf: 'flex-start' }}
        >
          <Text style={[type(text.xs), { color: t.colors.textTertiary }]}>
            {full ? 'Show less' : 'Show more'}
          </Text>
        </Pressable>
      ) : null}
    </View>
  )
}

/** `.chat-tool-panel`: what one call did, headed by its kind, the command or
 *  target as code, then what came back, the raw frames one tap further. */
export function ToolPanel({ tool }: { tool: ToolEntry }): ReactNode {
  const t = useTheme()
  const [raw, setRaw] = useState(false)
  const description = describeTool(tool)
  const { kind, target } = description
  const sections =
    kind === 'command'
      ? description.sections.filter((s) => s.label !== 'Command')
      : description.sections
  return (
    <View
      style={[
        styles.panel,
        { borderColor: t.colors.borderSubtle, backgroundColor: t.colors.surface50 }
      ]}
    >
      <View style={styles.panelHead}>
        <Text style={[type(text.xs), { color: t.colors.textTertiary }]}>{description.label}</Text>
        {description.detail ? (
          <Text style={[type(text.xs), { color: t.colors.textTertiary }]}>
            {description.detail}
          </Text>
        ) : null}
      </View>
      {kind === 'command' && target ? (
        <Preview section={{ label: 'Command', text: target }} language="bash" prompt />
      ) : null}
      {sections.map((section, index) => (
        <Preview key={index} section={section} language={sectionLanguage(kind, section, target)} />
      ))}
      {!sections.length ? (
        <Text style={[type(text.xs), { color: t.colors.textTertiary }]}>
          {tool.complete ? 'No output returned.' : 'Waiting for output…'}
        </Text>
      ) : null}
      <Pressable
        onPress={() => setRaw(!raw)}
        accessibilityRole="button"
        hitSlop={6}
        style={{ alignSelf: 'flex-start' }}
      >
        <Text style={[type(text.xs), { color: t.colors.textTertiary }]}>Raw input and output</Text>
      </Pressable>
      {raw ? (
        <View style={styles.section}>
          <Text style={[type(text.xs), { color: t.colors.textTertiary }]}>Input</Text>
          <CodeBlock
            code={tool.input === undefined ? 'No input recorded.' : stringify(tool.input)}
            style="panel"
          />
          <Text style={[type(text.xs), { color: t.colors.textTertiary }]}>Output</Text>
          <CodeBlock
            code={
              !tool.complete
                ? 'Not finished.'
                : tool.output === undefined
                  ? 'No output recorded.'
                  : stringify(tool.output)
            }
            style="panel"
          />
        </View>
      ) : null}
    </View>
  )
}

const toolStatus = (tool: ToolEntry): GroupStatus =>
  !tool.complete ? 'running' : tool.failed ? 'failed' : 'complete'

/** What a call's row reads: its verb, then the target it acted on. */
function ToolLine({ tool }: { tool: ToolEntry }): ReactNode {
  const t = useTheme()
  const { kind, label, target } = describeToolHead(tool)
  return (
    <Text style={[type(codeSize), styles.line, { color: t.colors.textTertiary }]} numberOfLines={1}>
      {toolVerb(kind, label)}
      {target ? (
        <Text style={{ color: t.colors.textTertiary }}>{`  ${target.split('\n')[0]}`}</Text>
      ) : null}
    </Text>
  )
}

/** One call inside an opened run: a row of its own that opens to the panel. */
function ToolItem({ tool }: { tool: ToolEntry }): ReactNode {
  const [open, setOpen] = useState(false)
  const status = toolStatus(tool)
  return (
    <View>
      <RowSummary
        kind={describeToolHead(tool).kind}
        status={status}
        open={open}
        onPress={() => setOpen(!open)}
      >
        <ToolLine tool={tool} />
      </RowSummary>
      {open ? <ToolPanel tool={tool} /> : null}
    </View>
  )
}

/** One row for a whole run of tools. The reader's choice to open it is the
 *  row's own state, so a result arriving mid-run neither opens nor closes it. */
export function ToolGroup({ group }: { group: Group }): ReactNode {
  const t = useTheme()
  const [open, setOpen] = useState(false)
  const status = groupStatus(group.tools)
  const failures = failureCount(group.tools)
  const lone = group.tools.length === 1 ? group.tools[0] : undefined
  return (
    <View style={styles.run} testID="entry-tool">
      <RowSummary
        kind={groupKind(group.tools)}
        status={status}
        open={open}
        onPress={() => setOpen(!open)}
        testID="tool-run"
      >
        {lone ? (
          <ToolLine tool={lone} />
        ) : (
          <Text
            style={[type(codeSize), styles.line, { color: t.colors.textTertiary }]}
            numberOfLines={1}
          >
            {toolGroupSummary(group.tools)}
          </Text>
        )}
        {failures > 0 ? (
          <Text style={[type(text.xs), { color: t.colors.destructive }]}>{failures} failed</Text>
        ) : null}
      </RowSummary>
      {open ? (
        lone ? (
          <View style={{ paddingTop: space(1) }}>
            <ToolPanel tool={lone} />
          </View>
        ) : (
          <View style={styles.items}>
            {group.tools.map((tool) => (
              <ToolItem key={tool.id} tool={tool} />
            ))}
          </View>
        )
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  run: { alignSelf: 'stretch', minWidth: 0 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space(2),
    paddingVertical: 3,
    minHeight: 28
  },
  line: { flexShrink: 1, minWidth: 0 },
  items: { paddingTop: 2 },
  panel: {
    gap: space(1.5),
    marginTop: 2,
    marginBottom: space(1.5),
    padding: space(2),
    paddingHorizontal: space(2.5),
    paddingBottom: space(2.5),
    borderWidth: 1,
    borderRadius: radius.lg
  },
  panelHead: { flexDirection: 'row', alignItems: 'center', gap: space(2) },
  section: { gap: space(1) }
})
