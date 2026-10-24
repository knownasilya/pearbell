package dev.pearbell.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.pearbell.Message

// Topics in a list of messages, most used first.
fun topicsOf(messages: List<Message>): List<Pair<String, Int>> =
  messages.map { it.topic }.filter { it.isNotEmpty() }
    .groupingBy { it }.eachCount()
    .toList()
    .sortedWith(compareByDescending<Pair<String, Int>> { it.second }.thenBy { it.first.lowercase() })

// "All" plus one chip per topic. Hidden when no message has a topic.
@Composable
fun TopicChips(topics: List<Pair<String, Int>>, total: Int, selected: String?, onSelect: (String?) -> Unit) {
  if (topics.isEmpty()) return
  LazyRow(
    contentPadding = PaddingValues(horizontal = 16.dp),
    horizontalArrangement = Arrangement.spacedBy(8.dp),
    modifier = Modifier.padding(vertical = 4.dp)
  ) {
    item(key = "all") {
      FilterChip(selected = selected == null, onClick = { onSelect(null) }, label = { Text("All  $total") })
    }
    items(topics, key = { it.first }) { (topic, count) ->
      FilterChip(
        selected = selected == topic,
        onClick = { onSelect(if (selected == topic) null else topic) },
        label = { Text("$topic  $count", maxLines = 1, overflow = TextOverflow.Ellipsis) }
      )
    }
  }
}

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
