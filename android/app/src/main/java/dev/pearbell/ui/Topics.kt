package dev.pearbell.ui

import android.text.format.DateUtils
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.SubcomposeLayout
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.pearbell.Message
import dev.pearbell.Peer
import dev.pearbell.R

data class TopicInfo(val name: String, val count: Int, val lastAt: Long)

// Topics in a list of messages, most used first.
fun topicsOf(messages: List<Message>): List<TopicInfo> =
  messages.filter { it.topic.isNotEmpty() }
    .groupBy { it.topic }
    .map { (name, list) -> TopicInfo(name, list.size, list.maxOf { it.receivedAt }) }
    .sortedWith(compareByDescending<TopicInfo> { it.count }.thenBy { it.name.lowercase() })

// Topics the user can write to: a computer that is still paired sent
// messages under them (see Phone.say in shared/phone.js).
fun askableTopics(messages: List<Message>, peers: List<Peer>): Set<String> {
  val paired = peers.map { it.publicKey }.toSet()
  return messages.filter { !it.mine && it.topic.isNotEmpty() && it.from in paired }.map { it.topic }.toSet()
}

// "All", then as many topics as fit on one line, then a chip that opens every
// topic (TopicsSheet). The picked topic always shows, right after "All".
@Composable
fun TopicChips(topics: List<TopicInfo>, total: Int, selected: String?, onSelect: (String?) -> Unit, onMore: () -> Unit) {
  if (topics.isEmpty()) return
  val ordered = selected?.let { s -> topics.filter { it.name == s } + topics.filter { it.name != s } } ?: topics

  SubcomposeLayout(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp)) { constraints ->
    val loose = constraints.copy(minWidth = 0, minHeight = 0)
    val gap = 8.dp.roundToPx()

    val all = subcompose("all") {
      FilterChip(selected = selected == null, onClick = { onSelect(null) }, label = { Text("All  $total") })
    }.first().measure(loose)
    val chips = subcompose("topics") {
      for (t in ordered) {
        Box {
          FilterChip(
            selected = selected == t.name,
            onClick = { onSelect(if (selected == t.name) null else t.name) },
            label = { Text("${t.name}  ${t.count}", maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 120.dp)) }
          )
        }
      }
    }.map { it.measure(loose) }
    // The widest the last chip gets, so the topics leave room for it.
    val widest = subcompose("probe") { MoreChip(ordered.size, onMore) }.first().measure(loose)

    var used = all.width + gap + widest.width
    var shown = 0
    for (chip in chips) {
      if (used + chip.width + gap > constraints.maxWidth) break
      used += chip.width + gap
      shown++
    }
    val more = subcompose("more") { MoreChip(chips.size - shown, onMore) }.first().measure(loose)

    val row = listOf(all) + chips.take(shown) + more
    val height = row.maxOf { it.height }
    layout(constraints.maxWidth, height) {
      var x = 0
      for (p in row) {
        p.placeRelative(x, (height - p.height) / 2)
        x += p.width + gap
      }
    }
  }
}

// Opens every topic. Says how many don't fit on the line.
@Composable
private fun MoreChip(hidden: Int, onClick: () -> Unit) {
  FilterChip(
    selected = false,
    onClick = onClick,
    leadingIcon = { Icon(painterResource(R.drawable.ic_topics), contentDescription = "All topics", modifier = Modifier.size(FilterChipDefaults.IconSize)) },
    label = { Text(if (hidden > 0) "+$hidden" else "Topics", maxLines = 1) }
  )
}

// Every topic with its message count and last message. Tap one to see only
// it; Ask (when onAsk is given) writes to whatever listens on it.
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TopicsSheet(
  topics: List<TopicInfo>,
  total: Int,
  selected: String?,
  askable: Set<String>,
  onSelect: (String?) -> Unit,
  onAsk: ((String) -> Unit)?,
  onDismiss: () -> Unit,
) {
  val now = LocalNow.current
  ModalBottomSheet(onDismissRequest = onDismiss) {
    Column(Modifier.navigationBarsPadding()) {
      Text("Topics", style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(start = 24.dp, end = 24.dp, bottom = 8.dp))
      LazyColumn(Modifier.fillMaxWidth()) {
        item(key = "all") {
          TopicRow("All messages", "$total ${plural(total)}", selected == null, null) { onSelect(null); onDismiss() }
        }
        items(topics, key = { it.name }) { t ->
          val last = DateUtils.getRelativeTimeSpanString(t.lastAt, now, DateUtils.MINUTE_IN_MILLIS)
          TopicRow(
            t.name,
            "${t.count} ${plural(t.count)} · last $last",
            selected == t.name,
            onAsk?.takeIf { t.name in askable }?.let { ask -> { ask(t.name); onDismiss() } },
          ) { onSelect(t.name); onDismiss() }
        }
      }
    }
  }
}

@Composable
private fun TopicRow(name: String, detail: String, picked: Boolean, onAsk: (() -> Unit)?, onClick: () -> Unit) {
  Row(
    Modifier.fillMaxWidth().clickable(onClick = onClick).padding(start = 24.dp, end = 12.dp, top = 10.dp, bottom = 10.dp),
    verticalAlignment = Alignment.CenterVertically
  ) {
    Column(Modifier.weight(1f)) {
      Text(
        name,
        style = MaterialTheme.typography.titleMedium,
        color = if (picked) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis
      )
      Text(detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
    }
    if (picked) {
      Spacer(Modifier.width(8.dp))
      Icon(painterResource(R.drawable.ic_check), contentDescription = "Showing", tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(20.dp))
    }
    if (onAsk != null) {
      Spacer(Modifier.width(4.dp))
      TextButton(onClick = onAsk) { Text("Ask") }
    }
  }
}

private fun plural(n: Int) = if (n == 1) "message" else "messages"

// A small topic tag for message rows.
@Composable
fun TopicTag(topic: String, modifier: Modifier = Modifier) {
  Surface(shape = CircleShape, color = MaterialTheme.colorScheme.secondaryContainer, modifier = modifier) {
    Text(
      topic,
      style = MaterialTheme.typography.labelSmall,
      color = MaterialTheme.colorScheme.onSecondaryContainer,
      maxLines = 1,
      overflow = TextOverflow.Ellipsis,
      modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp).widthIn(max = 120.dp)
    )
  }
}
