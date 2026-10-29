package dev.pearbell.ui

import android.app.TimePickerDialog
import android.content.Context
import android.text.format.DateFormat
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.pearbell.Hub
import dev.pearbell.Rest
import java.util.Calendar

// Monday first, the way a week reads. 0 is Sunday, as in shared/rest.js.
private val WEEK = listOf(1 to "Monday", 2 to "Tuesday", 3 to "Wednesday", 4 to "Thursday", 5 to "Friday", 6 to "Saturday", 0 to "Sunday")

// Rest hours: messages still arrive at night and on rest days, without a
// sound. Shared with every paired computer and the Mac app.
@Composable
fun RestSettings() {
  val rest by Hub.rest.collectAsStateWithLifecycle()
  val colors = MaterialTheme.colorScheme

  Surface(shape = RoundedCornerShape(18.dp), color = colors.surfaceContainerLow, modifier = Modifier.fillMaxWidth()) {
    Column(Modifier.padding(16.dp)) {
      Row(verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
          Text("Quiet at bedtime and on rest days", style = MaterialTheme.typography.bodyLarge)
          Text(
            "Messages still arrive, without a sound. Your computers use the same hours.",
            style = MaterialTheme.typography.labelMedium,
            color = colors.onSurfaceVariant
          )
        }
        Spacer(Modifier.width(12.dp))
        Switch(checked = rest.on, onCheckedChange = { Hub.setRest(rest.copy(on = it)) })
      }

      if (!rest.on) return@Column

      Spacer(Modifier.height(16.dp))
      Row(verticalAlignment = Alignment.CenterVertically) {
        Text("Bedtime", style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
        Switch(checked = rest.nightly, onCheckedChange = { Hub.setRest(rest.copy(nightly = it)) })
      }
      if (rest.nightly) {
        Spacer(Modifier.height(8.dp))
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
          TimeButton("From", rest.from, Modifier.weight(1f)) { Hub.setRest(rest.copy(from = it)) }
          TimeButton("Until", rest.until, Modifier.weight(1f)) { Hub.setRest(rest.copy(until = it)) }
        }
      }

      Spacer(Modifier.height(16.dp))
      Text("Rest days", style = MaterialTheme.typography.bodyLarge)
      Text("Quiet all day", style = MaterialTheme.typography.labelMedium, color = colors.onSurfaceVariant)
      Spacer(Modifier.height(8.dp))
      Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        for ((day, name) in WEEK) {
          val picked = day in rest.days
          Surface(
            onClick = { Hub.setRest(rest.copy(days = if (picked) rest.days - day else rest.days + day)) },
            shape = CircleShape,
            color = if (picked) colors.primary else colors.surfaceContainerHighest,
            modifier = Modifier.size(38.dp).semantics {
              contentDescription = name
              selected = picked
            }
          ) {
            Box(contentAlignment = Alignment.Center) {
              Text(name.take(1), style = MaterialTheme.typography.labelLarge, color = if (picked) colors.onPrimary else colors.onSurfaceVariant)
            }
          }
        }
      }
    }
  }
}

@Composable
private fun TimeButton(label: String, time: String, modifier: Modifier, onPick: (String) -> Unit) {
  val context = LocalContext.current
  val (h, m) = time.split(":").map { it.toIntOrNull() ?: 0 }
  FilledTonalButton(modifier = modifier, onClick = {
    TimePickerDialog(context, { _, hour, minute -> onPick("%02d:%02d".format(hour, minute)) }, h, m, DateFormat.is24HourFormat(context)).show()
  }) {
    Text("$label  ${shortTime(context, h, m)}")
  }
}

private fun shortTime(context: Context, hour: Int, minute: Int): String {
  val c = Calendar.getInstance().apply {
    set(Calendar.HOUR_OF_DAY, hour)
    set(Calendar.MINUTE, minute)
  }
  return DateFormat.getTimeFormat(context).format(c.time)
}
