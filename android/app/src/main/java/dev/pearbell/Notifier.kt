package dev.pearbell

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.RemoteInput
import android.content.Context
import android.content.Intent

object Notifier {
  const val SERVICE_ID = 1
  private const val CHANNEL_MESSAGES = "messages"
  private const val CHANNEL_SERVICE = "service"
  const val KEY_REPLY = "reply_text"

  fun createChannels(context: Context) {
    val nm = context.getSystemService(NotificationManager::class.java)
    nm.createNotificationChannel(
      NotificationChannel(CHANNEL_MESSAGES, "Messages", NotificationManager.IMPORTANCE_HIGH).apply {
        description = "Messages from your paired computers"
      }
    )
    nm.createNotificationChannel(
      NotificationChannel(CHANNEL_SERVICE, "Connection", NotificationManager.IMPORTANCE_MIN).apply {
        description = "Shows while pearbell listens for messages"
        setShowBadge(false)
      }
    )
  }

  fun serviceNotification(context: Context): Notification =
    Notification.Builder(context, CHANNEL_SERVICE)
      .setSmallIcon(R.drawable.ic_bell)
      .setContentTitle("Listening for messages")
      .setContentIntent(openApp(context))
      .setOngoing(true)
      .build()

  fun showMessage(context: Context, msg: Message) {
    val nm = context.getSystemService(NotificationManager::class.java)
    val builder = Notification.Builder(context, CHANNEL_MESSAGES)
      .setSmallIcon(R.drawable.ic_bell)
      .setContentTitle(msg.title.ifEmpty { msg.fromName })
      .setContentText(msg.body)
      .setStyle(Notification.BigTextStyle().bigText(msg.body))
      .setSubText(msg.fromName)
      .setWhen(msg.receivedAt)
      .setShowWhen(true)
      .setContentIntent(openApp(context))
      .setAutoCancel(!msg.wantsReply)
      .setCategory(Notification.CATEGORY_MESSAGE)

    if (msg.wantsReply) {
      // Android shows three buttons at most; keep one for the text reply.
      msg.actions.take(2).forEachIndexed { i, label ->
        val intent = replyIntent(context, msg.id).putExtra(ReplyReceiver.EXTRA_TEXT, label)
        val pi = PendingIntent.getBroadcast(
          context, requestCode(msg.id, i + 1), intent,
          PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        builder.addAction(Notification.Action.Builder(null, label, pi).build())
      }

      val input = RemoteInput.Builder(KEY_REPLY).setLabel("Reply").build()
      val pi = PendingIntent.getBroadcast(
        context, requestCode(msg.id, 0), replyIntent(context, msg.id),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
      )
      builder.addAction(Notification.Action.Builder(null, "Reply", pi).addRemoteInput(input).build())
    }

    nm.notify(notificationId(msg.id), builder.build())
  }

  fun cancel(context: Context, id: String) {
    context.getSystemService(NotificationManager::class.java).cancel(notificationId(id))
  }

  private fun replyIntent(context: Context, id: String) =
    Intent(context, ReplyReceiver::class.java).putExtra(ReplyReceiver.EXTRA_ID, id)

  private fun openApp(context: Context) = PendingIntent.getActivity(
    context, 0,
    Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
    PendingIntent.FLAG_IMMUTABLE
  )

  private fun notificationId(id: String) = id.hashCode() and 0x7fffffff or 0x100

  private fun requestCode(id: String, slot: Int) = (id.hashCode() and 0x0fffffff) * 4 + slot
}
