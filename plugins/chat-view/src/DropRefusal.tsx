import { dropRefusalWords, type DropRefusalState } from '../../../src/renderer/src/lib/drop-refusal'
import { DropDrawing } from './DropDrawing'
import { NoticeCard } from './NoticeCard'

/* The refusal card (PRDCT-4329): a notice docked above the composer when a
   drop on a server's tab leaves something on this Mac. The drawing is the
   folder-to-server one (`DropDrawing` kind `refused`); the words are
   `dropRefusalWords`. It never takes the caret: the person goes on typing,
   and it leaves with its X, Escape, the next drop or attach that lands, or
   the message being sent (`useComposerAttachments`). */

export function DropRefusal({
  refusal,
  server,
  onClose
}: {
  refusal: DropRefusalState
  /** The server the tab runs on, by the name the person gave it. */
  server: string
  onClose: () => void
}): React.JSX.Element {
  const { title, sentence } = dropRefusalWords(refusal.items, server)
  return (
    <NoticeCard
      tone="warning"
      placement="docked"
      drawing={<DropDrawing kind="refused" />}
      title={title}
      body={sentence}
      onDismiss={onClose}
      data={{ 'data-drop-refusal': refusal.items.length }}
    />
  )
}
