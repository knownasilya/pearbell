package dev.pearbell

import android.app.RemoteInput
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

// A tap on a quick-reply button or a typed reply in the notification.
class ReplyReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val id = intent.getStringExtra(EXTRA_ID) ?: return
    val text = intent.getStringExtra(EXTRA_TEXT)
      ?: RemoteInput.getResultsFromIntent(intent)?.getCharSequence(Notifier.KEY_REPLY)?.toString()
      ?: return

    BellService.start(context)
    Hub.answer(id, text)
    Notifier.cancel(context, id)
  }

  companion object {
    const val EXTRA_ID = "id"
    const val EXTRA_TEXT = "text"
  }
}

class BootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    BellService.start(context)
  }
}
