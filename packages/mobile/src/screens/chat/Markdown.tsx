/**
 * The assistant's Markdown as `.chat-prose` draws it: paragraphs a line
 * tighter than the view, headings in the semibold at three sizes, strong
 * semibold, inline code in the mono face on the surface-100 fill, fences on
 * surface-50 inside a hairline with the control's corner, tables in the
 * code size with tabular figures, blockquotes behind a rule, links in the
 * accent. The tree comes from `chat/markdown.ts` (the desktop's parser).
 */
import type { Content, PhrasingContent, Root, RootContent, Table } from 'mdast'
import { Fragment, useMemo, type ReactNode } from 'react'
import { Linking, StyleSheet, Text, View, type TextStyle } from 'react-native'
import { parseMarkdown } from '../../chat/markdown'
import { Icon } from '../../ui/Icon'
import { codeSize, mono, radius, space, text, type, useTheme, type Theme } from '../../ui/theme'

const external = (href: string): boolean => /^(https?:|mailto:)/i.test(href)

/** Inline content as nested Text: RN composes the styles down the tree. */
function Inline({
  nodes,
  t,
  inherit
}: {
  nodes: PhrasingContent[]
  t: Theme
  inherit?: TextStyle
}): ReactNode {
  return (
    <>
      {nodes.map((node, i) => {
        switch (node.type) {
          case 'text':
            return <Fragment key={i}>{node.value}</Fragment>
          case 'strong':
            return (
              <Text key={i} style={[inherit, type(inherit?.fontSize ?? text.sm, 600)]}>
                <Inline
                  nodes={node.children}
                  t={t}
                  inherit={{ ...inherit, ...type(inherit?.fontSize ?? text.sm, 600) }}
                />
              </Text>
            )
          case 'emphasis':
            return (
              <Text key={i} style={styles.italic}>
                <Inline nodes={node.children} t={t} inherit={inherit} />
              </Text>
            )
          case 'delete':
            return (
              <Text key={i} style={styles.strike}>
                <Inline nodes={node.children} t={t} inherit={inherit} />
              </Text>
            )
          case 'inlineCode':
            return (
              <Text key={i} style={[mono(codeSize), { backgroundColor: t.colors.surface100 }]}>
                {` ${node.value} `}
              </Text>
            )
          case 'link': {
            const href = node.url
            const ok = external(href)
            return (
              <Text
                key={i}
                style={ok ? { color: t.colors.accent, textDecorationLine: 'underline' } : undefined}
                onPress={ok ? () => void Linking.openURL(href).catch(() => {}) : undefined}
                accessibilityRole={ok ? 'link' : undefined}
              >
                <Inline nodes={node.children} t={t} inherit={inherit} />
              </Text>
            )
          }
          case 'break':
            return <Fragment key={i}>{'\n'}</Fragment>
          case 'image':
            return (
              <Text key={i} style={{ color: t.colors.textSecondary }}>
                {node.alt ?? node.url}
              </Text>
            )
          case 'html':
            return <Fragment key={i}>{node.value}</Fragment>
          default:
            return 'children' in node ? (
              <Inline
                key={i}
                nodes={(node as { children: PhrasingContent[] }).children}
                t={t}
                inherit={inherit}
              />
            ) : null
        }
      })}
    </>
  )
}

/** `.chat-prose pre`: a fence, and the same box a tool's section uses. */
export function CodeBlock({
  code,
  prompt,
  style
}: {
  code: string
  prompt?: boolean
  style?: 'prose' | 'panel'
}): ReactNode {
  const t = useTheme()
  const panel = style === 'panel'
  return (
    <View
      style={[
        styles.pre,
        panel
          ? { backgroundColor: t.colors.surface0, borderRadius: radius.md }
          : {
              backgroundColor: t.colors.surface50,
              borderColor: t.colors.borderSubtle,
              borderWidth: 1,
              borderRadius: radius.lg
            }
      ]}
    >
      <Text
        style={[
          mono(panel ? text.xs : codeSize),
          { color: panel ? t.colors.textSecondary : t.colors.textPrimary }
        ]}
        selectable
      >
        {prompt ? <Text style={{ color: t.colors.textTertiary }}>{'$ '}</Text> : null}
        {code}
      </Text>
    </View>
  )
}

function TableBlock({ node, t }: { node: Table; t: Theme }): ReactNode {
  return (
    <View style={[styles.table, { borderColor: t.colors.borderSubtle }]}>
      {node.children.map((row, r) => (
        <View
          key={r}
          style={[
            styles.tableRow,
            r > 0 ? { borderTopColor: t.colors.borderSubtle, borderTopWidth: 1 } : null
          ]}
        >
          {row.children.map((cell, c) => (
            <View
              key={c}
              style={[
                styles.tableCell,
                c > 0 ? { borderLeftColor: t.colors.borderSubtle, borderLeftWidth: 1 } : null
              ]}
            >
              <Text
                style={[
                  type(codeSize, 400, 1.5),
                  styles.tabular,
                  {
                    color: r === 0 ? t.colors.textSecondary : t.colors.textPrimary,
                    textAlign: node.align?.[c] ?? 'left'
                  }
                ]}
              >
                <Inline nodes={cell.children} t={t} inherit={type(codeSize, 400, 1.5)} />
              </Text>
            </View>
          ))}
        </View>
      ))}
    </View>
  )
}

function Block({
  node,
  t,
  depth = 0
}: {
  node: RootContent | Content
  t: Theme
  depth?: number
}): ReactNode {
  const body = type(text.sm, 400, 1.5)
  switch (node.type) {
    case 'paragraph':
      return (
        <Text style={[body, { color: t.colors.textPrimary }]} selectable>
          <Inline nodes={node.children} t={t} inherit={body} />
        </Text>
      )
    case 'heading': {
      const size = node.depth === 1 ? text.lg : node.depth === 2 ? text.base : text.sm
      const heading = type(size, 600, 1.35)
      return (
        <Text style={[heading, { color: t.colors.textPrimary, marginTop: space(2) }]} selectable>
          <Inline nodes={node.children} t={t} inherit={heading} />
        </Text>
      )
    }
    case 'code':
      return <CodeBlock code={node.value} />
    case 'list':
      return (
        <View style={styles.list}>
          {node.children.map((item, i) => (
            <View key={i} style={styles.listItem}>
              {item.checked === true || item.checked === false ? (
                <View
                  style={[
                    styles.box,
                    {
                      borderColor: item.checked ? t.colors.textPrimary : t.colors.textTertiary,
                      backgroundColor: item.checked ? t.colors.textPrimary : 'transparent'
                    }
                  ]}
                >
                  {item.checked ? <Icon name="check" size={10} color={t.colors.surface0} /> : null}
                </View>
              ) : (
                <Text style={[body, styles.marker, { color: t.colors.textSecondary }]}>
                  {node.ordered ? `${(node.start ?? 1) + i}.` : '•'}
                </Text>
              )}
              <View style={styles.listBody}>
                {item.children.map((child, j) => (
                  <Block key={j} node={child} t={t} depth={depth + 1} />
                ))}
              </View>
            </View>
          ))}
        </View>
      )
    case 'blockquote':
      return (
        <View style={[styles.quote, { borderLeftColor: t.colors.border }]}>
          {node.children.map((child, i) => (
            <Block key={i} node={child} t={t} depth={depth + 1} />
          ))}
        </View>
      )
    case 'thematicBreak':
      return <View style={[styles.rule, { backgroundColor: t.colors.rule }]} />
    case 'table':
      return <TableBlock node={node} t={t} />
    case 'html':
      return (
        <Text style={[body, { color: t.colors.textSecondary }]} selectable>
          {node.value}
        </Text>
      )
    default:
      return 'children' in node ? (
        <Text style={[body, { color: t.colors.textPrimary }]} selectable>
          <Inline nodes={node.children as PhrasingContent[]} t={t} inherit={body} />
        </Text>
      ) : null
  }
}

/** The whole answer: blocks spaced by the prose's own rhythm. */
export function Markdown({ text: source, testID }: { text: string; testID?: string }): ReactNode {
  const t = useTheme()
  const tree: Root = useMemo(() => parseMarkdown(source), [source])
  return (
    <View style={styles.prose} testID={testID}>
      {tree.children.map((node, i) => (
        <Block key={i} node={node} t={t} />
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  prose: { gap: space(3) },
  italic: { fontStyle: 'italic' },
  strike: { textDecorationLine: 'line-through' },
  pre: { paddingVertical: space(3), paddingHorizontal: space(3.5) },
  table: { borderWidth: 1, borderRadius: radius.sm, alignSelf: 'flex-start', maxWidth: '100%' },
  tableRow: { flexDirection: 'row' },
  tableCell: { paddingVertical: space(1), paddingHorizontal: space(2.5), flexShrink: 1 },
  tabular: { fontVariant: ['tabular-nums'] },
  list: { gap: space(1), paddingLeft: space(1) },
  listItem: { flexDirection: 'row', gap: space(2), alignItems: 'flex-start' },
  marker: { minWidth: space(4), textAlign: 'right' },
  listBody: { flex: 1, minWidth: 0, gap: space(1) },
  box: {
    width: 14,
    height: 14,
    borderWidth: 1,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4
  },
  quote: { paddingLeft: space(3), borderLeftWidth: 2, gap: space(3) },
  rule: { height: StyleSheet.hairlineWidth }
})
