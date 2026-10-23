package dev.pearbell

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.text.format.DateUtils
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions

class MainActivity : ComponentActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    enableEdgeToEdge()

    if (Build.VERSION.SDK_INT >= 33 &&
      checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
    ) {
      requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 0)
    }

    BellService.start(this)

    setContent {
      val colors = if (isSystemInDarkTheme()) {
        darkColorScheme(primary = Pear, secondary = Pear)
      } else {
        lightColorScheme(primary = PearDark, secondary = PearDark)
      }
      MaterialTheme(colorScheme = colors) {
        Surface(Modifier.fillMaxSize()) { App() }
      }
    }
  }
}

private val Pear = Color(0xFFB5D45C)
private val PearDark = Color(0xFF5B7A14)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun App() {
  val online by Hub.online.collectAsStateWithLifecycle()
  val peers by Hub.peers.collectAsStateWithLifecycle()
  val messages by Hub.messages.collectAsStateWithLifecycle()
  var screen by rememberSaveable { mutableStateOf("messages") }
  val linked = peers.any { it.connected }

  BackHandler(enabled = screen != "messages") { screen = "messages" }

  Scaffold(
    topBar = {
      TopAppBar(
        title = {
          Row(verticalAlignment = Alignment.CenterVertically) {
            Text(if (screen == "computers") "Computers" else "pearbell")
            Spacer(Modifier.width(10.dp))
            Surface(
              shape = CircleShape,
              color = if (linked) Pear else Color.Gray,
              modifier = Modifier.size(10.dp)
            ) {}
          }
        },
        actions = {
          if (screen == "messages") {
            TextButton(onClick = { screen = "computers" }) { Text("Computers (${peers.size})") }
          } else {
            TextButton(onClick = { screen = "messages" }) { Text("Done") }
          }
        }
      )
    }
  ) { padding ->
    Column(Modifier.padding(padding).fillMaxSize()) {
      BatteryHint()
      when {
        screen == "computers" -> ComputersScreen(peers)
        peers.isEmpty() -> PairCard(first = true)
        messages.isEmpty() -> Empty(online, linked)
        else -> MessageList(messages)
      }
    }
  }
}

@Composable
private fun Empty(online: Boolean, linked: Boolean) {
  Column(
    Modifier.fillMaxSize().padding(32.dp),
    verticalArrangement = Arrangement.Center,
    horizontalAlignment = Alignment.CenterHorizontally
  ) {
    Text("No messages yet", style = MaterialTheme.typography.titleMedium)
    Spacer(Modifier.size(8.dp))
    Text(
      when {
        !online -> "Starting…"
        linked -> "Try this on your computer:"
        else -> "Waiting for your computer. Run any pearbell command there to start its daemon."
      },
      style = MaterialTheme.typography.bodyMedium
    )
    if (linked) {
      Spacer(Modifier.size(8.dp))
      Text("pearbell send \"hello\"", fontFamily = FontFamily.Monospace)
    }
  }
}

@Composable
private fun MessageList(messages: List<Message>) {
  LazyColumn(
    Modifier.fillMaxSize(),
    contentPadding = androidx.compose.foundation.layout.PaddingValues(12.dp),
    verticalArrangement = Arrangement.spacedBy(10.dp)
  ) {
    items(messages, key = { it.id }) { MessageCard(it) }
  }
}

@Composable
private fun MessageCard(msg: Message) {
  var draft by rememberSaveable(msg.id) { mutableStateOf("") }

  Card(
    Modifier.fillMaxWidth(),
    colors = if (msg.open) {
      CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.secondaryContainer)
    } else {
      CardDefaults.cardColors()
    }
  ) {
    Column(Modifier.padding(14.dp)) {
      Row {
        Text(
          msg.fromName,
          style = MaterialTheme.typography.labelMedium,
          color = MaterialTheme.colorScheme.primary,
          modifier = Modifier.weight(1f)
        )
        Text(
          DateUtils.getRelativeTimeSpanString(msg.receivedAt).toString(),
          style = MaterialTheme.typography.labelSmall
        )
      }
      if (msg.title.isNotEmpty()) {
        Spacer(Modifier.size(4.dp))
        Text(msg.title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
      }
      Spacer(Modifier.size(4.dp))
      Text(msg.body, style = MaterialTheme.typography.bodyLarge)

      when {
        msg.answer != null -> {
          Spacer(Modifier.size(8.dp))
          Text("You replied: ${msg.answer}", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.primary)
        }
        msg.closed -> {
          Spacer(Modifier.size(8.dp))
          Text("No longer waiting for a reply", style = MaterialTheme.typography.bodyMedium)
        }
        msg.open -> {
          if (msg.actions.isNotEmpty()) {
            Spacer(Modifier.size(10.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
              msg.actions.forEach { label ->
                OutlinedButton(onClick = { Hub.answer(msg.id, label) }) { Text(label) }
              }
            }
          }
          Spacer(Modifier.size(8.dp))
          Row(verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
              value = draft,
              onValueChange = { draft = it },
              placeholder = { Text("Reply") },
              modifier = Modifier.weight(1f),
              keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
              keyboardActions = KeyboardActions(onSend = {
                if (draft.isNotBlank()) Hub.answer(msg.id, draft.trim())
              })
            )
            Spacer(Modifier.width(8.dp))
            Button(enabled = draft.isNotBlank(), onClick = { Hub.answer(msg.id, draft.trim()) }) {
              Text("Send")
            }
          }
        }
      }
    }
  }
}

@Composable
private fun ComputersScreen(peers: List<Peer>) {
  var forget by remember { mutableStateOf<Peer?>(null) }

  LazyColumn(
    Modifier.fillMaxSize(),
    contentPadding = androidx.compose.foundation.layout.PaddingValues(12.dp),
    verticalArrangement = Arrangement.spacedBy(10.dp)
  ) {
    items(peers, key = { it.publicKey }) { peer ->
      Card(Modifier.fillMaxWidth()) {
        Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
          Column(Modifier.weight(1f)) {
            Text(peer.name, style = MaterialTheme.typography.titleMedium)
            Text(
              if (peer.connected) "Connected" else "Not connected",
              style = MaterialTheme.typography.labelMedium,
              color = if (peer.connected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outline
            )
            Text(
              peer.publicKey.take(16) + "…",
              fontFamily = FontFamily.Monospace,
              style = MaterialTheme.typography.bodySmall
            )
          }
          TextButton(onClick = { forget = peer }) { Text("Forget") }
        }
      }
    }
    item { PairCard(first = peers.isEmpty()) }
    item {
      TextButton(onClick = { Hub.clear() }) { Text("Clear all messages") }
    }
  }

  forget?.let { peer ->
    AlertDialog(
      onDismissRequest = { forget = null },
      title = { Text("Forget ${peer.name}?") },
      text = { Text("It will not be able to reach this phone until you pair again.") },
      confirmButton = {
        TextButton(onClick = { Hub.unpair(peer.publicKey); forget = null }) { Text("Forget") }
      },
      dismissButton = { TextButton(onClick = { forget = null }) { Text("Cancel") } }
    )
  }
}

@Composable
private fun PairCard(first: Boolean) {
  val pairing by Hub.pairing.collectAsStateWithLifecycle()
  var code by rememberSaveable { mutableStateOf("") }
  val deviceName = Build.MODEL ?: "Android"

  val scan = rememberLauncherForActivityResult(ScanContract()) { result ->
    result.contents?.let {
      code = it
      Hub.pair(it, deviceName)
    }
  }

  Card(Modifier.fillMaxWidth().padding(if (first) 12.dp else 0.dp)) {
    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
      Text(if (first) "Pair with a computer" else "Pair another computer", style = MaterialTheme.typography.titleMedium)
      Text("On your computer, run:", style = MaterialTheme.typography.bodyMedium)
      Text("pearbell pair", fontFamily = FontFamily.Monospace)
      Text("Then scan the QR code it shows, or paste the code.", style = MaterialTheme.typography.bodyMedium)

      Button(
        onClick = {
          scan.launch(
            ScanOptions()
              .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
              .setPrompt("Scan the code from `pearbell pair`")
              .setBeepEnabled(false)
              .setOrientationLocked(false)
          )
        },
        modifier = Modifier.fillMaxWidth()
      ) { Text("Scan QR code") }

      OutlinedTextField(
        value = code,
        onValueChange = { code = it },
        label = { Text("Pairing code") },
        singleLine = true,
        modifier = Modifier.fillMaxWidth()
      )
      OutlinedButton(
        enabled = code.isNotBlank() && pairing != Pairing.Busy,
        onClick = { Hub.pair(code, deviceName) },
        modifier = Modifier.fillMaxWidth()
      ) { Text("Pair with code") }

      when (val p = pairing) {
        Pairing.Busy -> Text("Pairing…")
        is Pairing.Done -> Text("Paired with ${p.name}", color = MaterialTheme.colorScheme.primary)
        is Pairing.Failed -> Text("Could not pair: ${p.error}", color = MaterialTheme.colorScheme.error)
        Pairing.Idle -> {}
      }
    }
  }
}

// Doze cuts network access for apps on battery optimization, which would make
// the phone unreachable while the screen is off.
@SuppressLint("BatteryLife")
@Composable
private fun BatteryHint() {
  val context = LocalContext.current
  val power = context.getSystemService(PowerManager::class.java)
  var dismissed by rememberSaveable { mutableStateOf(false) }
  if (dismissed || power.isIgnoringBatteryOptimizations(context.packageName)) return

  Card(
    Modifier.fillMaxWidth().padding(12.dp),
    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.tertiaryContainer)
  ) {
    Column(Modifier.padding(14.dp)) {
      Text("Let pearbell run in the background", style = MaterialTheme.typography.titleSmall)
      Text(
        "Without this, Android may cut the connection while your screen is off.",
        style = MaterialTheme.typography.bodyMedium
      )
      Row {
        TextButton(onClick = {
          context.startActivity(
            Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${context.packageName}"))
          )
          dismissed = true
        }) { Text("Allow") }
        TextButton(onClick = { dismissed = true }) { Text("Not now") }
      }
    }
  }
}
