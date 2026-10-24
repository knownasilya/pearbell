package dev.pearbell

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.pearbell.ui.ArchiveScreen
import dev.pearbell.ui.BellHero
import dev.pearbell.ui.ComputersScreen
import dev.pearbell.ui.InboxScreen
import dev.pearbell.ui.PairScreen
import dev.pearbell.ui.PearbellTheme

class MainActivity : ComponentActivity() {
  companion object {
    const val EXTRA_OPEN = "open"
  }

  // From a notification: show that message.
  private fun handleOpen(intent: Intent?) {
    intent?.getStringExtra(EXTRA_OPEN)?.let { Hub.openMessage.value = it }
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    handleOpen(intent)
  }

  override fun onStart() {
    super.onStart()
    Hub.visible = true
  }

  override fun onStop() {
    super.onStop()
    Hub.visible = false
  }

  override fun onResume() {
    super.onResume()
    Updater.check(this)
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    enableEdgeToEdge()

    if (Build.VERSION.SDK_INT >= 33 &&
      checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
    ) {
      requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 0)
    }

    BellService.start(this)
    handleOpen(intent)

    setContent {
      PearbellTheme {
        Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) { App() }
      }
    }
  }
}

private val order = listOf("splash", "onboard", "inbox", "archive", "computers", "pair")

@Composable
private fun App() {
  val online by Hub.online.collectAsStateWithLifecycle()
  val peers by Hub.peers.collectAsStateWithLifecycle()
  val messages by Hub.messages.collectAsStateWithLifecycle()
  val pairing by Hub.pairing.collectAsStateWithLifecycle()
  var screen by rememberSaveable { mutableStateOf("inbox") }

  // Onboarding stays up until the user leaves its success screen.
  val target = when {
    !online && peers.isEmpty() -> "splash"
    peers.isEmpty() || (pairing is Pairing.Done && screen == "inbox") -> "onboard"
    else -> screen
  }

  fun go(to: String) {
    if (pairing !is Pairing.Busy) Hub.pairing.value = Pairing.Idle
    screen = to
  }

  val opening by Hub.openMessage.collectAsStateWithLifecycle()
  LaunchedEffect(opening) {
    if (opening != null && screen != "inbox") go("inbox")
  }

  BackHandler(enabled = target == "computers" || target == "pair" || target == "archive") {
    go(if (target == "pair") "computers" else "inbox")
  }

  AnimatedContent(
    targetState = target,
    transitionSpec = {
      val dir = if (order.indexOf(targetState) > order.indexOf(initialState)) 1 else -1
      (slideInHorizontally { it / 6 * dir } + fadeIn()) togetherWith (slideOutHorizontally { -it / 6 * dir } + fadeOut())
    },
    label = "screen"
  ) { s ->
    when (s) {
      "splash" -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { BellHero() }
      "onboard" -> PairScreen(first = true, onBack = {}, onDone = { go("inbox") })
      "archive" -> ArchiveScreen(messages, onBack = { go("inbox") })
      "computers" -> ComputersScreen(peers, onBack = { go("inbox") }, onPair = { go("pair") })
      "pair" -> PairScreen(first = false, onBack = { go("computers") }, onDone = { go("inbox") })
      else -> InboxScreen(online, peers, messages, onComputers = { go("computers") }, onArchive = { go("archive") })
    }
  }
}
