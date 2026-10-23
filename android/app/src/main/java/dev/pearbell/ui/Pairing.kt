package dev.pearbell.ui

import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import dev.pearbell.Hub
import dev.pearbell.Pairing
import dev.pearbell.R

// First-run onboarding (first = true) and "pair another computer".
@Composable
fun PairScreen(first: Boolean, onBack: () -> Unit, onDone: () -> Unit) {
  val pairing by Hub.pairing.collectAsStateWithLifecycle()

  Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding().imePadding()) {
    if (!first && pairing !is Pairing.Done) {
      IconButton(onClick = onBack, modifier = Modifier.padding(start = 8.dp, top = 8.dp)) {
        Icon(painterResource(R.drawable.ic_back), contentDescription = "Back")
      }
    }

    UpdateBanner()
    when (val p = pairing) {
      is Pairing.Done -> Success(p.name, onDone)
      else -> Steps(first, p)
    }
  }
}

@Composable
private fun Steps(first: Boolean, pairing: Pairing) {
  var code by rememberSaveable { mutableStateOf("") }
  var typing by rememberSaveable { mutableStateOf(false) }
  val deviceName = Build.MODEL ?: "Android"
  val busy = pairing == Pairing.Busy

  val scan = rememberLauncherForActivityResult(ScanContract()) { result ->
    result.contents?.let {
      code = it
      Hub.pair(it, deviceName)
    }
  }

  Column(
    Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp),
  ) {
    Spacer(Modifier.height(if (first) 48.dp else 8.dp))

    Box(
      Modifier.size(64.dp).background(MaterialTheme.colorScheme.primary, RoundedCornerShape(20.dp)),
      contentAlignment = Alignment.Center
    ) {
      Icon(painterResource(R.drawable.ic_bell), contentDescription = null, tint = MaterialTheme.colorScheme.onPrimary, modifier = Modifier.size(32.dp))
    }

    Spacer(Modifier.height(24.dp))
    Text(
      if (first) "Get pinged by\nyour terminal" else "Pair a computer",
      style = MaterialTheme.typography.displaySmall
    )
    Spacer(Modifier.height(12.dp))
    Text(
      if (first) {
        "Scripts and AI agents on your computer can tell you when they finish, or ask you something and wait for your answer."
      } else {
        "Link another computer to this phone."
      },
      style = MaterialTheme.typography.bodyLarge,
      color = MaterialTheme.colorScheme.onSurfaceVariant
    )

    Spacer(Modifier.height(32.dp))
    Step(1, "On your computer, run") {
      CodeChip("pearbell pair", Modifier.fillMaxWidth())
    }
    Spacer(Modifier.height(20.dp))
    Step(2, "Scan the QR code it shows") {}

    Spacer(Modifier.height(32.dp))
    Button(
      onClick = {
        scan.launch(
          ScanOptions()
            .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
            .setPrompt("Point at the QR code from `pearbell pair`")
            .setBeepEnabled(false)
            .setOrientationLocked(false)
        )
      },
      enabled = !busy,
      modifier = Modifier.fillMaxWidth().height(56.dp)
    ) {
      Icon(painterResource(R.drawable.ic_qr), contentDescription = null, modifier = Modifier.size(20.dp))
      Spacer(Modifier.width(10.dp))
      Text("Scan QR code", style = MaterialTheme.typography.titleMedium)
    }

    TextButton(onClick = { typing = !typing }, modifier = Modifier.align(Alignment.CenterHorizontally).padding(top = 4.dp)) {
      Text(if (typing) "Hide code field" else "Enter the code instead")
    }

    AnimatedVisibility(typing) {
      Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        OutlinedTextField(
          value = code,
          onValueChange = { code = it },
          label = { Text("Pairing code") },
          placeholder = { Text("pearbell1:…") },
          singleLine = true,
          shape = MaterialTheme.shapes.medium,
          textStyle = Mono,
          modifier = Modifier.fillMaxWidth()
        )
        FilledTonalButton(
          enabled = code.isNotBlank() && !busy,
          onClick = { Hub.pair(code, deviceName) },
          modifier = Modifier.fillMaxWidth().height(52.dp)
        ) { Text("Pair") }
      }
    }

    Spacer(Modifier.height(16.dp))
    when (pairing) {
      Pairing.Busy -> Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
        CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
        Spacer(Modifier.width(10.dp))
        Text("Reaching your computer…", style = MaterialTheme.typography.bodyMedium)
      }
      is Pairing.Failed -> Surface(shape = MaterialTheme.shapes.medium, color = MaterialTheme.colorScheme.errorContainer, modifier = Modifier.fillMaxWidth()) {
        Text(
          "Could not pair: ${pairing.error}. Is `pearbell pair` still running?",
          modifier = Modifier.padding(14.dp),
          style = MaterialTheme.typography.bodyMedium,
          color = MaterialTheme.colorScheme.onErrorContainer
        )
      }
      else -> {}
    }

    Spacer(Modifier.height(24.dp))
    Row(verticalAlignment = Alignment.CenterVertically) {
      Icon(painterResource(R.drawable.ic_lock), contentDescription = null, tint = MaterialTheme.colorScheme.outline, modifier = Modifier.size(16.dp))
      Spacer(Modifier.width(8.dp))
      Text(
        "Peer-to-peer and end-to-end encrypted. No account, no server.",
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.outline
      )
    }
    Spacer(Modifier.height(24.dp))
  }
}

@Composable
private fun Step(number: Int, label: String, content: @Composable () -> Unit) {
  Row {
    Box(
      Modifier.size(28.dp).background(MaterialTheme.colorScheme.secondaryContainer, CircleShape),
      contentAlignment = Alignment.Center
    ) {
      Text("$number", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSecondaryContainer)
    }
    Spacer(Modifier.width(14.dp))
    Column(Modifier.weight(1f).padding(top = 3.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
      Text(label, style = MaterialTheme.typography.titleMedium)
      content()
    }
  }
}

@Composable
private fun Success(name: String, onDone: () -> Unit) {
  Column(
    Modifier.fillMaxSize().padding(24.dp),
    horizontalAlignment = Alignment.CenterHorizontally,
    verticalArrangement = Arrangement.Center
  ) {
    Box(
      Modifier.size(96.dp).background(MaterialTheme.colorScheme.primaryContainer, CircleShape),
      contentAlignment = Alignment.Center
    ) {
      Icon(painterResource(R.drawable.ic_check), contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(48.dp))
    }
    Spacer(Modifier.height(28.dp))
    Text("You're paired", style = MaterialTheme.typography.headlineMedium)
    Spacer(Modifier.height(8.dp))
    Text(
      "$name can now reach this phone. Try it:",
      style = MaterialTheme.typography.bodyLarge,
      color = MaterialTheme.colorScheme.onSurfaceVariant,
      textAlign = TextAlign.Center
    )
    Spacer(Modifier.height(16.dp))
    CodeChip("pearbell ask -a \"Yes,No\" \"Working?\"")
    Spacer(Modifier.height(40.dp))
    Button(onClick = onDone, modifier = Modifier.fillMaxWidth().height(56.dp)) {
      Text("Go to inbox", style = MaterialTheme.typography.titleMedium)
    }
  }
}
