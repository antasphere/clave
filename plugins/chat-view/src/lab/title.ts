import type { DigestStateOf } from '../digest'
import type { PageTitleDone } from '../../../../src/shared/page-title'
import type { Page } from './pages'

/** The title a page shows once its state is known: the written one when it
 *  is done, else the stand-in (PRDCT-4412). Pure, for the head, the spine
 *  and the contents. */
export function shownTitle(
  page: Pick<Page, 'title'>,
  state: DigestStateOf<PageTitleDone> | undefined
): string {
  const written = state?.state === 'done' ? state.result.title?.trim() : ''
  return written || page.title
}

/** Whether a page's title is still being written. */
export const titlePending = (state: DigestStateOf<PageTitleDone>): boolean =>
  state.state === 'waiting' || state.state === 'reading'
