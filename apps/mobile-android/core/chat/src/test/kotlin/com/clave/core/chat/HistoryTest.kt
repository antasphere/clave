package com.clave.core.chat

import com.clave.core.contract.HistoryItem
import com.clave.core.contract.HistoryPage
import com.clave.core.contract.SessionEvent
import com.clave.core.contract.SessionPosition
import com.clave.core.contract.TimelineItem
import com.clave.core.contract.TimelinePage
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class HistoryTest {
    @Test
    fun `the first page sets the cursor and the conversation`() {
        val (conversation, cursor) = applyFirstPage(
            emptyConversation,
            HistoryPage(listOf(HistoryItem(SessionEvent.UserMessage(text = "latest"))), before = 200),
        )
        assertEquals(1, conversation.entries.size)
        assertEquals(HistoryCursor(before = 200, loaded = true, loading = false), cursor)
        assertTrue(hasMore(cursor))
        assertTrue(shouldLoadOlder(cursor))
        assertFalse(shouldLoadOlder(cursor.copy(loading = true)))
    }

    @Test
    fun `an older page goes in front and the cursor moves back until null`() {
        val first = applyFirstPage(
            emptyConversation,
            HistoryPage(listOf(HistoryItem(SessionEvent.UserMessage(text = "latest"))), before = 200),
        )
        val older = applyOlderPage(
            first.conversation,
            HistoryPage(listOf(HistoryItem(SessionEvent.UserMessage(text = "earlier"))), before = null),
        )
        assertEquals(listOf("earlier", "latest"), older.conversation.entries.map { (it as? Entry.User)?.text ?: "" })
        assertEquals(-1, older.conversation.first)
        assertFalse(hasMore(older.cursor))
    }

    @Test
    fun `nothing loads before the first page`() {
        assertFalse(hasMore(freshCursor))
        assertFalse(shouldLoadOlder(freshCursor))
    }

    @Test
    fun `keeps a new identical delta beyond the snapshot watermark`() {
        val event = SessionEvent.AssistantText("a", false)
        val page = TimelinePage(
            items = listOf(TimelineItem(event, position = SessionPosition("g", 1))),
            before = null,
            cursor = SessionPosition("g", 1),
            truncated = false,
        )
        val joined = mergeBufferedHistory(page, listOf(BufferedItem(event, position = SessionPosition("g", 2))))
        val applied = applyFirstPage(emptyConversation, joined)
        assertEquals("aa", (applied.conversation.entries[0] as Entry.Assistant).text)
    }

    @Test
    fun `deduplicates positions only and rejects generation changes or gaps`() {
        val event = SessionEvent.AssistantText("a", false)
        fun item(sequence: Long, generation: String = "g") = BufferedItem(event, position = SessionPosition(generation, sequence))
        val page = TimelinePage(
            items = listOf(TimelineItem(event, position = SessionPosition("g", 4))),
            cursor = SessionPosition("g", 4),
            before = null,
            truncated = true,
        )
        assertEquals(listOf(item(4), item(5), item(6)), mergeBufferedHistory(page, listOf(item(4), item(6), item(5), item(5))).items)
        assertThrows(TimelineChanged::class.java) { mergeBufferedHistory(page, listOf(item(5, "new"))) }
        assertThrows(TimelineChanged::class.java) { mergeBufferedHistory(page, listOf(item(6))) }
    }
}
