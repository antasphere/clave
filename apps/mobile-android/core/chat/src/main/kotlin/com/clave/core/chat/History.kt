/**
 * The page cursor of a conversation's past. The server answers the newest page first,
 * each page oldest event first, with `before` naming where the page before it ends and
 * null when there is none: the first page replaces what the phone holds (`sync`), every
 * further page goes in front (`prepend`), one at a time. Ported from
 * `apps/mobile/src/chat/history.ts`.
 */
package com.clave.core.chat

import com.clave.core.contract.HistoryItem
import com.clave.core.contract.HistoryPage
import com.clave.core.contract.SessionEvent
import com.clave.core.contract.SessionPosition
import com.clave.core.contract.TimelinePage

data class HistoryCursor(
    /** Where the next older page ends; null when the past is all here. */
    val before: Long?,
    /** The first page has landed. */
    val loaded: Boolean,
    /** A page is on its way. */
    val loading: Boolean,
    /** Server retention removed earlier events. */
    val truncated: Boolean = false,
)

val freshCursor: HistoryCursor = HistoryCursor(before = null, loaded = false, loading = false)

fun hasMore(cursor: HistoryCursor): Boolean = cursor.loaded && cursor.before != null

data class AppliedPage(val conversation: Conversation, val cursor: HistoryCursor)

/** The first page: the conversation rebuilt from it, the cursor set. */
fun applyFirstPage(conversation: Conversation, page: HistoryPage, truncated: Boolean = false): AppliedPage =
    AppliedPage(
        conversation = if (page.items.isNotEmpty()) reduceConversation(conversation, Action.Sync(page.items)) else conversation,
        cursor = HistoryCursor(page.before, loaded = true, loading = false, truncated = truncated),
    )

fun applyFirstPage(conversation: Conversation, page: MergedHistory): AppliedPage =
    applyFirstPage(conversation, page.toHistoryPage(), page.truncated)

/** A further page, in front of what is here; the cursor moves back. */
fun applyOlderPage(conversation: Conversation, page: HistoryPage, truncated: Boolean = false): AppliedPage =
    AppliedPage(
        conversation = if (page.items.isNotEmpty()) reduceConversation(conversation, Action.Prepend(page.items)) else conversation,
        cursor = HistoryCursor(page.before, loaded = true, loading = false, truncated = truncated),
    )

/** Whether to ask for the page before the oldest one shown: only when the first page is
 *  here, the past is not all here, and no page is on its way. */
fun shouldLoadOlder(cursor: HistoryCursor): Boolean = hasMore(cursor) && !cursor.loading

/** An event the stream delivered while the snapshot was loading; [position] is absent on a
 *  synthetic prompt replay, which has no ordered identity. */
data class BufferedItem(val event: SessionEvent, val at: Long? = null, val position: SessionPosition? = null)

data class MergedHistory(val items: List<BufferedItem>, val before: Long?, val truncated: Boolean) {
    fun toHistoryPage(): HistoryPage = HistoryPage(items.map { HistoryItem(it.event, it.at) }, before)
}

class TimelineChanged : Exception("The conversation changed while history was loading. Refresh it again.")

/** Only the server's positions establish identity: identical text can be new. Throws
 *  [TimelineChanged] on another generation or a gap in the sequence. */
fun mergeBufferedHistory(page: TimelinePage, buffered: List<BufferedItem>): MergedHistory {
    val seen = HashSet<Long>()
    val newer = buffered.filter { item ->
        val position = item.position ?: return@filter true
        if (position.generation != page.cursor.generation) throw TimelineChanged()
        if (position.sequence <= page.cursor.sequence || position.sequence in seen) return@filter false
        seen.add(position.sequence)
        true
    }
    val ordered = newer.filter { it.position != null }.sortedBy { it.position!!.sequence }
    var next = page.cursor.sequence + 1
    for (item in ordered) {
        if (item.position!!.sequence != next++) throw TimelineChanged()
    }
    return MergedHistory(
        items = page.items.map { BufferedItem(it.event, it.at, it.position) } + ordered + newer.filter { it.position == null },
        before = page.before,
        truncated = page.truncated,
    )
}
