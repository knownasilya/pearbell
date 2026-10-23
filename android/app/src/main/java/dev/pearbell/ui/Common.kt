package dev.pearbell.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.text.format.DateFormat
import android.text.format.DateUtils
import android.widget.Toast
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.dp
import dev.pearbell.R
import java.util.Calendar

// A line of shell code with a copy button.
@Composable
fun CodeChip(code: String, modifier: Modifier = Modifier) {
  val context = LocalContext.current
  Surface(
    modifier = modifier,
    shape = MaterialTheme.shapes.small,
    color = MaterialTheme.colorScheme.surfaceContainerHigh
  ) {
    Row(Modifier.padding(start = 14.dp), verticalAlignment = Alignment.CenterVertically) {
      Text("$ ", style = Mono, color = MaterialTheme.colorScheme.onSurfaceVariant)
      Text(code, style = Mono, color = MaterialTheme.colorScheme.onSurface, modifier = Modifier.weight(1f))
      IconButton(onClick = { copy(context, code) }) {
        Icon(
          painterResource(R.drawable.ic_copy),
          contentDescription = "Copy",
          modifier = Modifier.size(18.dp),
          tint = MaterialTheme.colorScheme.onSurfaceVariant
        )
      }
    }
  }
}

fun copy(context: Context, text: String) {
  context.getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("pearbell", text))
  Toast.makeText(context, "Copied", Toast.LENGTH_SHORT).show()
}

// "now", "4m", "2h", then the clock time.
fun shortTime(context: Context, at: Long): String {
  val ago = System.currentTimeMillis() - at
  return when {
    ago < DateUtils.MINUTE_IN_MILLIS -> "now"
    ago < DateUtils.HOUR_IN_MILLIS -> "${ago / DateUtils.MINUTE_IN_MILLIS}m"
    ago < 6 * DateUtils.HOUR_IN_MILLIS -> "${ago / DateUtils.HOUR_IN_MILLIS}h"
    else -> DateFormat.getTimeFormat(context).format(at)
  }
}

fun dayLabel(context: Context, at: Long): String {
  val today = Calendar.getInstance()
  val day = Calendar.getInstance().apply { timeInMillis = at }
  val sameYear = today.get(Calendar.YEAR) == day.get(Calendar.YEAR)
  val diff = today.get(Calendar.DAY_OF_YEAR) - day.get(Calendar.DAY_OF_YEAR)
  return when {
    sameYear && diff == 0 -> "Today"
    sameYear && diff == 1 -> "Yesterday"
    else -> DateUtils.formatDateTime(
      context, at,
      DateUtils.FORMAT_SHOW_DATE or DateUtils.FORMAT_SHOW_WEEKDAY or DateUtils.FORMAT_ABBREV_ALL
    )
  }
}
