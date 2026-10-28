package dev.pearbell.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilledTonalIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.dp
import dev.pearbell.R

// A "More" menu with one destructive item: delete every message in view.
// It always names how many and where, and asks before it deletes.
// where: "inbox" or "archive"; topic: the picked topic chip, if any.
@Composable
internal fun MoreMenu(count: Int, where: String, topic: String?, onDeleteAll: () -> Unit) {
  var open by rememberSaveable { mutableStateOf(false) }
  var confirming by rememberSaveable { mutableStateOf(false) }
  val n = if (count == 1) "1 message" else "$count messages"
  val scope = if (topic == null) "in the $where" else "in $topic"

  Box {
    FilledTonalIconButton(onClick = { open = true }) {
      Icon(painterResource(R.drawable.ic_more_vert), contentDescription = "More options", modifier = Modifier.size(20.dp))
    }
    DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
      DropdownMenuItem(
        text = { Text(if (topic == null) "Delete all in $where…" else "Delete all in $topic…", color = MaterialTheme.colorScheme.error) },
        leadingIcon = { Icon(painterResource(R.drawable.ic_delete), contentDescription = null, tint = MaterialTheme.colorScheme.error) },
        enabled = count > 0,
        onClick = { open = false; confirming = true }
      )
    }
  }

  if (confirming) {
    AlertDialog(
      onDismissRequest = { confirming = false },
      icon = { Icon(painterResource(R.drawable.ic_delete), contentDescription = null) },
      title = { Text("Delete $n?") },
      text = {
        Text(
          "Every message $scope is deleted from this phone." +
            (if (where == "inbox") " Questions waiting for your answer stay." else "") +
            " You can undo right after."
        )
      },
      confirmButton = {
        TextButton(onClick = { confirming = false; onDeleteAll() }) {
          Text("Delete", color = MaterialTheme.colorScheme.error)
        }
      },
      dismissButton = { TextButton(onClick = { confirming = false }) { Text("Cancel") } }
    )
  }
}
