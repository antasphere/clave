import { memo, useLayoutEffect, useState, useSyncExternalStore } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  createMarkdownAttempt,
  createMarkdownStore,
  type MarkdownAttempt,
  type MarkdownStore
} from './markdown-parser-reuse'

interface Props {
  children: string
  final: boolean
  components?: Components
  singleTilde?: boolean
}
interface RendererProps extends Props {
  store: MarkdownStore
  attempt: MarkdownAttempt
}

const MarkdownRenderer = memo(
  function MarkdownRenderer({
    children,
    components,
    singleTilde = true,
    store,
    attempt
  }: RendererProps) {
    useLayoutEffect(() => {
      // ReactMarkdown parses in the nested child render. This effect only runs
      // after that exact subtree has successfully committed, including replay.
      if (attempt.ready()) store.publish(attempt.candidate())
      attempt.release()
      return attempt.release
    }, [attempt, store])
    return (
      <ReactMarkdown
        remarkPlugins={[[remarkGfm, { singleTilde }], attempt.plugin]}
        components={components}
      >
        {children}
      </ReactMarkdown>
    )
  },
  (previous, next) =>
    previous.children === next.children &&
    previous.final === next.final &&
    previous.components === next.components &&
    previous.singleTilde === next.singleTilde &&
    previous.store === next.store
)

/** Shared assistant boundary. Both parser paths keep this exact renderer
 * and the caller's stable component map. */
export function MarkdownMessage(props: Props): React.JSX.Element {
  const [store] = useState(createMarkdownStore)
  const committed = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const attempt = createMarkdownAttempt(
    committed,
    props.children,
    props.final,
    `remark-gfm4:singleTilde=${props.singleTilde ?? true}`
  )
  useLayoutEffect(() => store.clear, [store])
  return <MarkdownRenderer {...props} store={store} attempt={attempt} />
}
