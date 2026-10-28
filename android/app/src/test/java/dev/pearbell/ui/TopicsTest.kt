package dev.pearbell.ui

import dev.pearbell.Message
import dev.pearbell.Peer
import dev.pearbell.Recipient
import org.junit.Assert.assertEquals
import org.junit.Test

class TopicsTest {
  private fun msg(id: String, topic: String, from: String = "aa", at: Long = 0, mine: Boolean = false, to: List<Recipient> = emptyList()) = Message(
    id = id, from = from, fromName = "", title = "", topic = topic, body = "", actions = emptyList(),
    wantsReply = false, receivedAt = at, answer = null, answeredAt = null, closed = false, archived = false,
    mine = mine, to = to,
  )

  @Test
  fun topicsCountAndSortByUse() {
    val topics = topicsOf(listOf(msg("1", "kody", at = 5), msg("2", "pearbell", at = 1), msg("3", "pearbell", at = 9), msg("4", "")))
    assertEquals(listOf(TopicInfo("pearbell", 2, 9), TopicInfo("kody", 1, 5)), topics)
  }

  @Test
  fun onlyTopicsFromPairedComputersTakeAsks() {
    val peers = listOf(Peer("aa", "laptop", 0, true))
    val messages = listOf(msg("1", "kody"), msg("2", "old", from = "gone"), msg("3", "mine-only", from = "", mine = true))
    assertEquals(setOf("kody"), askableTopics(messages, peers))
  }

  @Test
  fun heardStatusSaysWhoListened() {
    fun status(vararg heard: Int?) = heardStatus(msg("m", "t", mine = true, to = heard.mapIndexed { i, h -> Recipient("k$i", "pc$i", h) })).first
    assertEquals("Waiting for pc0", status(null))
    assertEquals("Heard by 1 session", status(1))
    assertEquals("Heard by 2 sessions, waiting for pc1", status(2, null))
    assertEquals("Nobody listening on pc0, pc1", status(0, 0))
  }
}
