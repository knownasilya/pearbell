package dev.pearbell.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import dev.pearbell.Message
import dev.pearbell.R

@Composable
fun ArchiveScreen(all: List<Message>, onBack: () -> Unit) = ProvideNow {
  val context = LocalContext.current
  val inArchive = all.filter { it.archived }
  val topics = topicsOf(inArchive)
  var picked by rememberSaveable { mutableStateOf<String?>(null) }
  val topic = picked?.takeIf { t -> topics.any { it.name == t } }
  var allTopics by rememberSaveable { mutableStateOf(false) }
  val archived = if (topic == null) inArchive else inArchive.filter { it.topic == topic }
  val days = archived.groupBy { dayLabel(context, it.receivedAt) }
  val snackbar = remember { SnackbarHostState() }
  val actions = rememberMessageActions(snackbar)
  var details by rememberSaveable { mutableStateOf<String?>(null) }

  Box(Modifier.fillMaxSize()) {
    Column(Modifier.fillMaxSize().statusBarsPadding()) {
      Row(Modifier.padding(start = 8.dp, top = 8.dp, end = 16.dp), verticalAlignment = Alignment.CenterVertically) {
        IconButton(onClick = onBack) { Icon(painterResource(R.drawable.ic_back), contentDescription = "Back") }
        Spacer(Modifier.width(4.dp))
        Text("Archive", style = MaterialTheme.typography.headlineMedium, modifier = Modifier.weight(1f))
        MoreMenu(archived.size, "archive", topic) { actions.deleteAll(archived) }
      }
      TopicChips(topics, inArchive.size, topic, onSelect = { picked = it }, onMore = { allTopics = true })

      if (archived.isEmpty()) {
        Column(
          Modifier.fillMaxSize().padding(horizontal = 32.dp),
          verticalArrangement = Arrangement.Center,
          horizontalAlignment = Alignment.CenterHorizontally
        ) {
          Icon(
            painterResource(R.drawable.ic_archive),
            contentDescription = null,
            tint = MaterialTheme.colorScheme.outline,
            modifier = Modifier.size(48.dp)
          )
          Spacer(Modifier.height(16.dp))
          Text("Nothing archived", style = MaterialTheme.typography.titleLarge)
          Spacer(Modifier.height(6.dp))
          Text(
            "In the inbox, swipe a message left to keep it here.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center
          )
          Spacer(Modifier.height(80.dp))
        }
      } else {
        LazyColumn(
          Modifier.fillMaxSize(),
          contentPadding = PaddingValues(
            start = 16.dp, end = 16.dp, top = 8.dp,
            bottom = 24.dp + WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
          )
        ) {
          history(days, inArchive = true, actions) { details = it.id }
          item(key = "hint") { SwipeTip("Swipe left to move back to the inbox, right to delete", Modifier.animateItem()) }
        }
      }
    }

    SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter).navigationBarsPadding())
  }

  if (allTopics) {
    TopicsSheet(topics, inArchive.size, topic, emptySet(), onSelect = { picked = it }, onAsk = null) { allTopics = false }
  }

  details?.let { id -> all.find { it.id == id } }?.let { msg ->
    MessageDetails(msg, actions) { details = null }
  }
}
