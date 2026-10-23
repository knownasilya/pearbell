package dev.pearbell.ui

import android.os.Build
import android.text.format.DateUtils
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.dp
import dev.pearbell.Hub
import dev.pearbell.Peer
import dev.pearbell.R

@Composable
fun ComputersScreen(peers: List<Peer>, onBack: () -> Unit, onPair: () -> Unit) {
  var forget by remember { mutableStateOf<Peer?>(null) }
  var clearing by remember { mutableStateOf(false) }

  Column(Modifier.fillMaxSize().statusBarsPadding()) {
    Row(Modifier.padding(start = 8.dp, top = 8.dp, end = 16.dp), verticalAlignment = Alignment.CenterVertically) {
      IconButton(onClick = onBack) { Icon(painterResource(R.drawable.ic_back), contentDescription = "Back") }
      Spacer(Modifier.width(4.dp))
      Text("Computers", style = MaterialTheme.typography.headlineMedium)
    }

    LazyColumn(
      Modifier.fillMaxSize().navigationBarsPadding(),
      contentPadding = PaddingValues(16.dp)
    ) {
      itemsIndexed(peers, key = { _, p -> p.publicKey }) { i, peer ->
        val first = i == 0
        val last = i == peers.lastIndex
        val shape = RoundedCornerShape(
          topStart = if (first) 18.dp else 4.dp, topEnd = if (first) 18.dp else 4.dp,
          bottomStart = if (last) 18.dp else 4.dp, bottomEnd = if (last) 18.dp else 4.dp
        )
        Surface(
          shape = shape,
          color = MaterialTheme.colorScheme.surfaceContainerLow,
          modifier = Modifier.fillMaxWidth().padding(bottom = if (last) 0.dp else 2.dp)
        ) {
          Row(Modifier.padding(start = 16.dp, top = 14.dp, bottom = 14.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(
              Modifier.size(44.dp).background(MaterialTheme.colorScheme.secondaryContainer, RoundedCornerShape(14.dp)),
              contentAlignment = Alignment.Center
            ) {
              Icon(painterResource(R.drawable.ic_laptop), contentDescription = null, tint = MaterialTheme.colorScheme.onSecondaryContainer)
            }
            Spacer(Modifier.width(14.dp))
            Column(Modifier.weight(1f)) {
              Text(peer.name, style = MaterialTheme.typography.titleMedium)
              Spacer(Modifier.height(2.dp))
              Row(verticalAlignment = Alignment.CenterVertically) {
                StatusDot(peer.connected)
                Spacer(Modifier.width(6.dp))
                Text(
                  if (peer.connected) "Connected" else "Not connected",
                  style = MaterialTheme.typography.labelLarge,
                  color = if (peer.connected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant
                )
                Text(
                  " · paired " + DateUtils.getRelativeTimeSpanString(peer.pairedAt, System.currentTimeMillis(), DateUtils.DAY_IN_MILLIS),
                  style = MaterialTheme.typography.labelMedium,
                  color = MaterialTheme.colorScheme.onSurfaceVariant
                )
              }
            }
            IconButton(onClick = { forget = peer }) {
              Icon(painterResource(R.drawable.ic_delete), contentDescription = "Forget ${peer.name}", tint = MaterialTheme.colorScheme.onSurfaceVariant)
            }
          }
        }
      }

      item {
        OutlinedButton(onClick = onPair, modifier = Modifier.fillMaxWidth().padding(top = 16.dp).height(52.dp)) {
          Icon(painterResource(R.drawable.ic_add), contentDescription = null, modifier = Modifier.size(18.dp))
          Spacer(Modifier.width(8.dp))
          Text("Pair another computer")
        }
      }

      item {
        Column(Modifier.padding(top = 40.dp, start = 4.dp, end = 4.dp)) {
          Text("This phone", style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
          Spacer(Modifier.height(8.dp))
          Text(
            "Shows up as “${Build.MODEL}” on your computers. Messages travel straight between your devices over the Pear network, end-to-end encrypted. No server keeps a copy.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant
          )
          TextButton(onClick = { clearing = true }, modifier = Modifier.padding(top = 8.dp)) {
            Text("Clear message history", color = MaterialTheme.colorScheme.error)
          }
        }
      }
    }
  }

  forget?.let { peer ->
    AlertDialog(
      onDismissRequest = { forget = null },
      title = { Text("Forget ${peer.name}?") },
      text = { Text("It can't reach this phone until you pair again.") },
      confirmButton = { TextButton(onClick = { Hub.unpair(peer.publicKey); forget = null }) { Text("Forget") } },
      dismissButton = { TextButton(onClick = { forget = null }) { Text("Cancel") } }
    )
  }

  if (clearing) {
    AlertDialog(
      onDismissRequest = { clearing = false },
      title = { Text("Clear all messages?") },
      text = { Text("This removes the history on this phone. Open questions are dropped too.") },
      confirmButton = { TextButton(onClick = { Hub.clear(); clearing = false }) { Text("Clear") } },
      dismissButton = { TextButton(onClick = { clearing = false }) { Text("Cancel") } }
    )
  }
}
