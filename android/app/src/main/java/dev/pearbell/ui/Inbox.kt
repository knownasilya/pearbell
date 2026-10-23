package dev.pearbell.ui

import android.annotation.SuppressLint
import android.content.Intent
import android.net.Uri
import android.os.PowerManager
import android.provider.Settings
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.FilledTonalIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.LifecycleResumeEffect
import dev.pearbell.Hub
import dev.pearbell.Message
import dev.pearbell.Peer
import dev.pearbell.R

@Composable
fun InboxScreen(online: Boolean, peers: List<Peer>, messages: List<Message>, onComputers: () -> Unit) {
  ProvideNow { Inbox(online, peers, messages, onComputers) }
}

@Composable
private fun Inbox(online: Boolean, peers: List<Peer>, messages: List<Message>, onComputers: () -> Unit) {
  val open = messages.filter { it.open }
  val rest = messages.filterNot { it.open }
  val context = LocalContext.current
  val days = rest.groupBy { dayLabel(context, it.receivedAt) }

  Column(Modifier.fillMaxSize().statusBarsPadding()) {
    Column(Modifier.fillMaxWidth().padding(start = 20.dp, end = 16.dp, top = 16.dp, bottom = 8.dp)) {
      Row(verticalAlignment = Alignment.CenterVertically) {
        Text("Inbox", style = MaterialTheme.typography.displaySmall, modifier = Modifier.weight(1f))
        FilledTonalIconButton(onClick = onComputers) {
          Icon(painterResource(R.drawable.ic_laptop), contentDescription = "Computers", modifier = Modifier.size(20.dp))
        }
      }
      Spacer(Modifier.height(8.dp))
      ConnectionPill(online, peers, onComputers)
    }

    BatteryBanner()

    if (messages.isEmpty()) {
      EmptyInbox(peers)
      return@Column
    }

    // The list keeps its first visible row in place, so a message that lands
    // above it would stay off screen. Bring it into view if we are near the top.
    val list = rememberLazyListState()
    LaunchedEffect(messages.firstOrNull()?.id, open.size) {
      if (list.firstVisibleItemIndex <= 2) list.animateScrollToItem(0)
    }

    LazyColumn(
      Modifier.fillMaxSize().imePadding(),
      state = list,
      contentPadding = PaddingValues(
        start = 16.dp, end = 16.dp, top = 8.dp,
        bottom = 24.dp + WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
      )
    ) {
      if (open.isNotEmpty()) {
        item(key = "h-open") { SectionHeader("Waiting for you", open.size, Modifier.animateItem()) }
        itemsIndexed(open, key = { _, m -> m.id }) { _, msg ->
          QuestionCard(msg, Modifier.animateItem().padding(bottom = 12.dp))
        }
      }

      for ((day, list) in days) {
        item(key = "h-$day") { SectionHeader(day, null, Modifier.animateItem()) }
        itemsIndexed(list, key = { _, m -> m.id }) { i, msg ->
          MessageRow(msg, first = i == 0, last = i == list.lastIndex, Modifier.animateItem())
        }
      }
    }
  }
}

@Composable
private fun ConnectionPill(online: Boolean, peers: List<Peer>, onClick: () -> Unit) {
  val up = peers.count { it.connected }
  val text = when {
    !online -> "Starting…"
    peers.size == 1 && up == 1 -> "Connected to ${peers[0].name}"
    peers.size == 1 -> "Waiting for ${peers[0].name}"
    else -> "$up of ${peers.size} computers online"
  }

  Surface(onClick = onClick, shape = CircleShape, color = MaterialTheme.colorScheme.surfaceContainer) {
    Row(Modifier.padding(horizontal = 12.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
      PulsingDot(up > 0)
      Spacer(Modifier.width(8.dp))
      Text(text, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
  }
}

@Composable
private fun PulsingDot(online: Boolean) {
  // Pulse a few times when the link comes up, then rest: a forever animation
  // would redraw the screen every frame while the app is open.
  val t = remember { Animatable(1f) }
  LaunchedEffect(online) {
    if (!online) return@LaunchedEffect
    repeat(3) {
      t.snapTo(0f)
      t.animateTo(1f, tween(1400))
    }
  }

  Box(contentAlignment = Alignment.Center, modifier = Modifier.size(14.dp)) {
    if (online && t.value < 1f) {
      Box(
        Modifier.size(14.dp).scale(0.6f + t.value * 0.8f).alpha((1f - t.value) * 0.5f)
          .background(LocalExtra.current.online, CircleShape)
      )
    }
    StatusDot(online)
  }
}

@Composable
private fun SectionHeader(text: String, count: Int?, modifier: Modifier = Modifier) {
  Row(modifier.padding(start = 4.dp, top = 18.dp, bottom = 10.dp), verticalAlignment = Alignment.CenterVertically) {
    Text(text, style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    if (count != null) {
      Spacer(Modifier.width(8.dp))
      Box(
        Modifier.background(MaterialTheme.colorScheme.primary, CircleShape).padding(horizontal = 7.dp, vertical = 1.dp)
      ) {
        Text("$count", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onPrimary)
      }
    }
  }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun QuestionCard(msg: Message, modifier: Modifier = Modifier) {
  val context = LocalContext.current
  var draft by rememberSaveable(msg.id) { mutableStateOf("") }
  val send = { if (draft.isNotBlank()) Hub.answer(msg.id, draft.trim()) }
  val accent = MaterialTheme.colorScheme.primary

  Surface(
    modifier = modifier.fillMaxWidth().border(1.dp, accent.copy(alpha = 0.35f), MaterialTheme.shapes.large),
    shape = MaterialTheme.shapes.large,
    color = MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.45f)
  ) {
    Column(Modifier.padding(18.dp)) {
      Row(verticalAlignment = Alignment.CenterVertically) {
        Avatar(msg.title.ifEmpty { msg.fromName }, 36.dp)
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
          Text(msg.title.ifEmpty { msg.fromName }, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
          Text(
            "${msg.fromName} · ${shortTime(context, msg.receivedAt, LocalNow.current)}",
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis
          )
        }
      }

      Spacer(Modifier.height(14.dp))
      Text(msg.body, style = MaterialTheme.typography.bodyLarge.copy(fontSize = 18.sp, lineHeight = 26.sp))

      if (msg.actions.isNotEmpty()) {
        Spacer(Modifier.height(16.dp))
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
          msg.actions.forEachIndexed { i, label ->
            if (i == 0) {
              Button(onClick = { Hub.answer(msg.id, label) }) { Text(label) }
            } else {
              OutlinedButton(onClick = { Hub.answer(msg.id, label) }) { Text(label) }
            }
          }
        }
      }

      Spacer(Modifier.height(12.dp))
      TextField(
        value = draft,
        onValueChange = { draft = it },
        placeholder = { Text("Write a reply…") },
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(24.dp),
        maxLines = 4,
        colors = TextFieldDefaults.colors(
          focusedContainerColor = MaterialTheme.colorScheme.surfaceContainerLowest,
          unfocusedContainerColor = MaterialTheme.colorScheme.surfaceContainerLowest,
          focusedIndicatorColor = Color.Transparent,
          unfocusedIndicatorColor = Color.Transparent,
        ),
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
        keyboardActions = KeyboardActions(onSend = { send() }),
        trailingIcon = {
          IconButton(onClick = send, enabled = draft.isNotBlank()) {
            Icon(
              painterResource(R.drawable.ic_send),
              contentDescription = "Send",
              tint = if (draft.isNotBlank()) accent else MaterialTheme.colorScheme.outline
            )
          }
        }
      )
    }
  }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun MessageRow(msg: Message, first: Boolean, last: Boolean, modifier: Modifier = Modifier) {
  val context = LocalContext.current
  var expanded by rememberSaveable(msg.id) { mutableStateOf(false) }
  val r = 18.dp
  val shape = RoundedCornerShape(
    topStart = if (first) r else 4.dp, topEnd = if (first) r else 4.dp,
    bottomStart = if (last) r else 4.dp, bottomEnd = if (last) r else 4.dp
  )

  Column(modifier.padding(bottom = if (last) 0.dp else 2.dp)) {
    Surface(shape = shape, color = MaterialTheme.colorScheme.surfaceContainerLow) {
      Row(
        Modifier
          .fillMaxWidth()
          .combinedClickable(onClick = { expanded = !expanded }, onLongClick = { copy(context, msg.body) })
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
            Spacer(Modifier.width(8.dp))
            Text(
              shortTime(context, msg.receivedAt, LocalNow.current),
              style = MaterialTheme.typography.labelMedium,
              color = MaterialTheme.colorScheme.onSurfaceVariant
            )
          }
          Spacer(Modifier.height(2.dp))
          Text(
            msg.body,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = if (expanded) Int.MAX_VALUE else 3,
            overflow = TextOverflow.Ellipsis
          )

          when {
            msg.answer != null -> Status(R.drawable.ic_check, "You replied “${msg.answer}”", MaterialTheme.colorScheme.primary)
            msg.wantsReply && msg.closed -> Status(R.drawable.ic_close, "Expired without a reply", MaterialTheme.colorScheme.outline)
          }

          if (expanded && msg.title.isNotEmpty()) {
            Spacer(Modifier.height(6.dp))
            Text(
              "From ${msg.fromName} · long-press to copy",
              style = MaterialTheme.typography.labelSmall,
              color = MaterialTheme.colorScheme.outline
            )
          }
        }
      }
    }
  }
}

@Composable
private fun Status(icon: Int, text: String, color: Color) {
  Row(Modifier.padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
    Icon(painterResource(icon), contentDescription = null, tint = color, modifier = Modifier.size(16.dp))
    Spacer(Modifier.width(6.dp))
    Text(text, style = MaterialTheme.typography.labelLarge, color = color, maxLines = 2, overflow = TextOverflow.Ellipsis)
  }
}

@Composable
private fun EmptyInbox(peers: List<Peer>) {
  val linked = peers.any { it.connected }
  Column(
    Modifier.fillMaxSize().padding(horizontal = 32.dp),
    verticalArrangement = Arrangement.Center,
    horizontalAlignment = Alignment.CenterHorizontally
  ) {
    BellHero()
    Spacer(Modifier.height(28.dp))
    Text("All quiet", style = MaterialTheme.typography.headlineMedium)
    Spacer(Modifier.height(8.dp))
    Text(
      if (linked) "Messages from your terminal land here. Send yourself one:"
      else "Waiting for your computer. Run any pearbell command there to wake it up.",
      style = MaterialTheme.typography.bodyLarge,
      color = MaterialTheme.colorScheme.onSurfaceVariant,
      textAlign = TextAlign.Center
    )
    Spacer(Modifier.height(20.dp))
    CodeChip(if (linked) "pearbell send \"hello\"" else "pearbell devices")
    Spacer(Modifier.height(80.dp))
  }
}

@Composable
fun BellHero() {
  val ring = MaterialTheme.colorScheme.primary
  Box(contentAlignment = Alignment.Center, modifier = Modifier.size(168.dp)) {
    Box(Modifier.size(168.dp).background(ring.copy(alpha = 0.06f), CircleShape))
    Box(Modifier.size(124.dp).background(ring.copy(alpha = 0.10f), CircleShape))
    Box(Modifier.size(84.dp).background(MaterialTheme.colorScheme.primary, CircleShape), contentAlignment = Alignment.Center) {
      Icon(painterResource(R.drawable.ic_bell), contentDescription = null, tint = MaterialTheme.colorScheme.onPrimary, modifier = Modifier.size(40.dp))
    }
  }
}

// Doze cuts network access for apps on battery optimization, which would make
// the computer unreachable while the screen is off.
@SuppressLint("BatteryLife")
@Composable
private fun BatteryBanner() {
  val context = LocalContext.current
  val power = remember { context.getSystemService(PowerManager::class.java) }
  var exempt by remember { mutableStateOf(power.isIgnoringBatteryOptimizations(context.packageName)) }
  var dismissed by rememberSaveable { mutableStateOf(false) }

  LifecycleResumeEffect(Unit) {
    exempt = power.isIgnoringBatteryOptimizations(context.packageName)
    onPauseOrDispose {}
  }
  if (dismissed || exempt) return

  Surface(
    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
    shape = MaterialTheme.shapes.medium,
    color = MaterialTheme.colorScheme.tertiaryContainer
  ) {
    Row(Modifier.padding(start = 16.dp, top = 12.dp, bottom = 12.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
      Icon(painterResource(R.drawable.ic_bolt), contentDescription = null, tint = MaterialTheme.colorScheme.tertiary)
      Spacer(Modifier.width(12.dp))
      Column(Modifier.weight(1f)) {
        Text("Stay reachable", style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.onTertiaryContainer)
        Text(
          "Let pearbell run in the background so messages arrive when the screen is off.",
          style = MaterialTheme.typography.bodySmall,
          color = MaterialTheme.colorScheme.onTertiaryContainer
        )
      }
      TextButton(onClick = {
        context.startActivity(
          Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${context.packageName}"))
        )
      }) { Text("Allow", color = MaterialTheme.colorScheme.tertiary) }
      IconButton(onClick = { dismissed = true }) {
        Icon(painterResource(R.drawable.ic_close), contentDescription = "Dismiss", modifier = Modifier.size(18.dp), tint = MaterialTheme.colorScheme.onTertiaryContainer)
      }
    }
  }
}
