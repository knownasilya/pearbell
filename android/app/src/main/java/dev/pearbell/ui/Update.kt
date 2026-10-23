package dev.pearbell.ui

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import android.widget.Toast
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.pearbell.R
import dev.pearbell.Updater
import dev.pearbell.Updater.State

// Start an install, after making sure Android lets this app install APKs.
fun startUpdate(context: Context, release: Updater.Release) {
  if (!context.packageManager.canRequestPackageInstalls()) {
    Toast.makeText(context, "Allow pearbell to install updates, then tap Update again", Toast.LENGTH_LONG).show()
    context.startActivity(
      Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}"))
    )
    return
  }
  Updater.install(context, release)
}

@Composable
fun UpdateBanner() {
  val context = LocalContext.current
  val state by Updater.state.collectAsStateWithLifecycle()
  val colors = MaterialTheme.colorScheme

  val (title, failed) = when (val s = state) {
    State.Idle -> return
    is State.Available -> "pearbell ${s.release.version} is available" to false
    is State.Downloading -> "Downloading ${s.release.version}… ${(s.progress * 100).toInt()}%" to false
    is State.Installing -> "Installing ${s.release.version}…" to false
    is State.Failed -> "Update failed" to true
  }

  Surface(
    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
    shape = MaterialTheme.shapes.medium,
    color = if (failed) colors.errorContainer else colors.primaryContainer
  ) {
    Column(Modifier.padding(start = 16.dp, top = 12.dp, bottom = 12.dp, end = 8.dp)) {
      Row(verticalAlignment = Alignment.CenterVertically) {
        Icon(
          painterResource(R.drawable.ic_download),
          contentDescription = null,
          tint = if (failed) colors.onErrorContainer else colors.primary
        )
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
          Text(title, style = MaterialTheme.typography.titleSmall, color = if (failed) colors.onErrorContainer else colors.onPrimaryContainer)
          (state as? State.Failed)?.let {
            Text(it.error, style = MaterialTheme.typography.bodySmall, color = colors.onErrorContainer)
          }
        }
        when (val s = state) {
          is State.Available -> TextButton(onClick = { startUpdate(context, s.release) }) { Text("Update") }
          is State.Failed -> {
            s.release?.let { r -> TextButton(onClick = { startUpdate(context, r) }) { Text("Retry") } }
            IconButton(onClick = { Updater.state.value = State.Idle }) {
              Icon(painterResource(R.drawable.ic_close), contentDescription = "Dismiss", modifier = Modifier.size(18.dp))
            }
          }
          else -> {}
        }
      }
      (state as? State.Downloading)?.let {
        Spacer(Modifier.height(10.dp))
        LinearProgressIndicator(progress = { it.progress }, modifier = Modifier.fillMaxWidth().padding(end = 8.dp))
      }
    }
  }
}

// Version, auto-install switch and a manual check, for the Computers screen.
@Composable
fun UpdateSettings() {
  val context = LocalContext.current
  val state by Updater.state.collectAsStateWithLifecycle()
  var auto by remember { mutableStateOf(Updater.autoInstall(context)) }

  Column {
    Row(verticalAlignment = Alignment.CenterVertically) {
      Column(Modifier.weight(1f)) {
        Text("Install updates automatically", style = MaterialTheme.typography.bodyMedium)
        Text(
          "Version ${Updater.currentVersion(context)}" + when (state) {
            is State.Available -> " · update available"
            State.Idle -> ""
            else -> " · updating"
          },
          style = MaterialTheme.typography.labelMedium,
          color = MaterialTheme.colorScheme.onSurfaceVariant
        )
      }
      Switch(checked = auto, onCheckedChange = {
        auto = it
        Updater.setAutoInstall(context, it)
      })
    }
    TextButton(onClick = {
      Toast.makeText(context, "Checking for updates…", Toast.LENGTH_SHORT).show()
      Updater.check(context, force = true)
    }) { Text("Check for updates") }
  }
}
