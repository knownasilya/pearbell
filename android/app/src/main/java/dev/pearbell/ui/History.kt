package dev.pearbell.ui

import android.content.Context
import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.Surface
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.Text
import androidx.compose.material3.rememberSwipeToDismissBoxState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.pearbell.Hub
import dev.pearbell.Message
import dev.pearbell.Notifier
import dev.pearbell.R
import java.text.DateFormat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

// Archive, unarchive, delete and clear all, each with an Undo bar.
class MessageActions(
  private val context: Context,
  private val scope: CoroutineScope,
  private val snackbar: SnackbarHostState,
) {
  fun archive(msg: Message, archived: Boolean = true) {
    Notifier.cancel(context, msg.id)
    Hub.archive(msg.id, archived)
    undo(if (archived) "Archived" else "Moved to inbox") { Hub.archive(msg.id, !archived) }
  }

  fun delete(msg: Message) {
    Notifier.cancel(context, msg.id)
    Hub.delete(msg.id)
    undo("Deleted") { Hub.undelete(msg.id) }
  }

  fun deleteAll(msgs: List<Message>) {
    if (msgs.isEmpty()) return
    msgs.forEach { Notifier.cancel(context, it.id) }
    Hub.deleteAll(msgs.map { it.id })
    undo(if (msgs.size == 1) "Deleted 1 message" else "Deleted ${msgs.size} messages") { Hub.undeleteAll() }
  }

  private fun undo(text: String, revert: () -> Unit) {
    scope.launch {
      snackbar.currentSnackbarData?.dismiss()
      val result = snackbar.showSnackbar(text, actionLabel = "Undo", duration = SnackbarDuration.Short)
      if (result == SnackbarResult.ActionPerformed) revert()
    }
  }
}

@Composable
fun rememberMessageActions(snackbar: SnackbarHostState): MessageActions {
  val context = LocalContext.current.applicationContext
  val scope = rememberCoroutineScope()
  return remember(snackbar) { MessageActions(context, scope, snackbar) }
}

// Day-grouped rows. Swipe right deletes; swipe left archives (or, in the
// archive, moves back to the inbox).
fun LazyListScope.history(
  days: Map<String, List<Message>>,
  inArchive: Boolean,
  actions: MessageActions,
  onOpen: (Message) -> Unit,
) {
  for ((day, list) in days) {
    item(key = "h-$day") { SectionHeader(day, null, Modifier.animateItem()) }
    itemsIndexed(list, key = { _, m -> m.id }) { i, msg ->
      MessageRow(msg, first = i == 0, last = i == list.lastIndex, inArchive, actions, { onOpen(msg) }, Modifier.animateItem())
    }
  }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun MessageRow(
  msg: Message,
  first: Boolean,
  last: Boolean,
  inArchive: Boolean,
  actions: MessageActions,
  onOpen: () -> Unit,
  modifier: Modifier = Modifier,
) {
  val context = LocalContext.current
  val current by rememberUpdatedState(msg)
  val r = 18.dp
  val shape = RoundedCornerShape(
    topStart = if (first) r else 4.dp, topEnd = if (first) r else 4.dp,
    bottomStart = if (last) r else 4.dp, bottomEnd = if (last) r else 4.dp
  )

  val swipe = rememberSwipeToDismissBoxState(confirmValueChange = { value ->
    when (value) {
      SwipeToDismissBoxValue.StartToEnd -> { actions.delete(current); true }
      SwipeToDismissBoxValue.EndToStart -> { actions.archive(current, !inArchive); true }
      SwipeToDismissBoxValue.Settled -> false
    }
  })

  Column(modifier.padding(bottom = if (last) 0.dp else 2.dp)) {
    SwipeToDismissBox(
      state = swipe,
      modifier = Modifier.clip(shape),
      backgroundContent = { SwipeBackground(swipe.dismissDirection, inArchive) }
    ) {
      Surface(shape = shape, color = MaterialTheme.colorScheme.surfaceContainerLow) {
        Row(
          Modifier
            .fillMaxWidth()
            .combinedClickable(onClick = onOpen, onLongClick = { copy(context, msg.body) })
            .padding(horizontal = 16.dp, vertical = 14.dp)
            .animateContentSize()
        ) {
          Avatar(msg.title.ifEmpty { msg.fromName })
          Spacer(Modifier.width(14.dp))
          Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
              Text(
                msg.title.ifEmpty { msg.fromName },
                style = MaterialTheme.typography.titleSmall,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f)
              )
              if (msg.topic.isNotEmpty()) {
                Spacer(Modifier.width(8.dp))
                TopicTag(msg.topic)
              }
              Spacer(Modifier.width(8.dp))
              Text(
                messageTime(context, msg, LocalNow.current),
                style = MaterialTheme.typography.labelMedium,
                color = if (msg.updatedAt != null) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant
              )
            }
            Spacer(Modifier.height(2.dp))
            Text(
              rememberMarkdown(msg.body, links = false),
              style = MaterialTheme.typography.bodyMedium,
              color = MaterialTheme.colorScheme.onSurfaceVariant,
              maxLines = 3,
              overflow = TextOverflow.Ellipsis
            )
            statusOf(msg)?.let { (icon, text, color) -> Status(icon, text, color) }
          }
        }
      }
    }
  }
}

@Composable
private fun SwipeBackground(direction: SwipeToDismissBoxValue, inArchive: Boolean) {
  val colors = MaterialTheme.colorScheme
  when (direction) {
    SwipeToDismissBoxValue.StartToEnd -> SwipeHint(colors.errorContainer, colors.onErrorContainer, R.drawable.ic_delete, "Delete", Alignment.CenterStart)
    SwipeToDismissBoxValue.EndToStart -> SwipeHint(
      colors.secondaryContainer, colors.onSecondaryContainer,
      if (inArchive) R.drawable.ic_unarchive else R.drawable.ic_archive,
      if (inArchive) "Inbox" else "Archive",
      Alignment.CenterEnd
    )
    SwipeToDismissBoxValue.Settled -> {}
  }
}

@Composable
private fun SwipeHint(bg: Color, fg: Color, icon: Int, label: String, align: Alignment) {
  Box(Modifier.fillMaxSize().background(bg).padding(horizontal = 24.dp), contentAlignment = align) {
    Row(verticalAlignment = Alignment.CenterVertically) {
      Icon(painterResource(icon), contentDescription = null, tint = fg, modifier = Modifier.size(20.dp))
      Spacer(Modifier.width(8.dp))
      Text(label, style = MaterialTheme.typography.labelLarge, color = fg)
    }
  }
}

@Composable
private fun statusOf(msg: Message): Triple<Int, String, Color>? = when {
  msg.answer != null -> Triple(R.drawable.ic_check, "You replied “${msg.answer}”", MaterialTheme.colorScheme.primary)
  msg.wantsReply && msg.closed -> Triple(R.drawable.ic_close, "Expired without a reply", MaterialTheme.colorScheme.outline)
  else -> null
}

@Composable
private fun Status(icon: Int, text: String, color: Color) {
  Row(Modifier.padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
    Icon(painterResource(icon), contentDescription = null, tint = color, modifier = Modifier.size(16.dp))
    Spacer(Modifier.width(6.dp))
    Text(text, style = MaterialTheme.typography.labelLarge, color = color, maxLines = 2, overflow = TextOverflow.Ellipsis)
  }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MessageDetails(msg: Message, actions: MessageActions, onDismiss: () -> Unit) {
  val context = LocalContext.current
  val time = remember { DateFormat.getDateTimeInstance(DateFormat.FULL, DateFormat.MEDIUM) }
  val status = when {
    msg.answer != null -> "Replied “${msg.answer}”"
    msg.wantsReply && msg.closed -> "Expired without a reply"
    msg.open -> "Waiting for your answer"
    else -> "Delivered"
  }

  ModalBottomSheet(onDismissRequest = onDismiss) {
    Column(
      Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(start = 24.dp, end = 24.dp, bottom = 32.dp)
    ) {
      Row(verticalAlignment = Alignment.CenterVertically) {
        Avatar(msg.title.ifEmpty { msg.fromName }, 44.dp)
        Spacer(Modifier.width(14.dp))
        Column {
          Text(msg.title.ifEmpty { msg.fromName }, style = MaterialTheme.typography.titleLarge)
          Text(
            listOfNotNull(if (msg.wantsReply) "Question" else "Notification", if (msg.archived) "Archived" else null).joinToString(" · "),
            style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant
          )
        }
      }

      Spacer(Modifier.height(18.dp))
      SelectionContainer {
        MarkdownText(msg.body, links = true, style = MaterialTheme.typography.bodyLarge)
      }

      Spacer(Modifier.height(20.dp))
      HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
      Detail("From", msg.fromName, msg.from.takeIf { it.isNotEmpty() }?.let { it.take(16) + "…" })
      if (msg.topic.isNotEmpty()) Detail("Topic", msg.topic)
      Detail("Received", time.format(msg.receivedAt))
      msg.updatedAt?.let { Detail("Updated", time.format(it), if (msg.updates > 1) "${msg.updates} updates" else null) }
      if (msg.wantsReply) Detail("Options", msg.actions.joinToString(" · ").ifEmpty { "Free text reply" })
      Detail("Status", status)
      msg.answeredAt?.let { Detail("Replied", time.format(it)) }
      msg.key?.let { Detail("Sender ID", it, mono = true) }
      Detail("Message ID", msg.id, mono = true)

      Spacer(Modifier.height(20.dp))
      Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedButton(onClick = { copy(context, msg.body) }) {
          Icon(painterResource(R.drawable.ic_copy), contentDescription = null, modifier = Modifier.size(18.dp))
          Spacer(Modifier.width(8.dp))
          Text("Copy")
        }
        if (!msg.open) {
          OutlinedButton(onClick = { actions.archive(msg, !msg.archived); onDismiss() }) {
            Icon(
              painterResource(if (msg.archived) R.drawable.ic_unarchive else R.drawable.ic_archive),
              contentDescription = null, modifier = Modifier.size(18.dp)
            )
            Spacer(Modifier.width(8.dp))
            Text(if (msg.archived) "To inbox" else "Archive")
          }
          OutlinedButton(
            onClick = { actions.delete(msg); onDismiss() },
            colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error)
          ) {
            Icon(painterResource(R.drawable.ic_delete), contentDescription = null, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(8.dp))
            Text("Delete")
          }
        }
      }
    }
  }
}

@Composable
private fun Detail(label: String, value: String, extra: String? = null, mono: Boolean = false) {
  Row(Modifier.fillMaxWidth().padding(vertical = 10.dp)) {
    Text(
      label,
      style = MaterialTheme.typography.labelLarge,
      color = MaterialTheme.colorScheme.onSurfaceVariant,
      modifier = Modifier.width(104.dp)
    )
    Column(Modifier.weight(1f)) {
      Text(value, style = if (mono) Mono else MaterialTheme.typography.bodyMedium)
      if (extra != null) {
        Text(extra, style = Mono.copy(fontSize = MaterialTheme.typography.labelSmall.fontSize), color = MaterialTheme.colorScheme.outline)
      }
    }
  }
}
